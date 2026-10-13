#!/usr/bin/env node
/**
 * "Aplicar aos publicados" com a regra NET (Decisão 31) — classificação e execução contra
 * uma loja Shopify falsa (sem rede) e uma fila temporária:
 *   - mudar de regra marca os publicados como a atualizar, com o único motivo "regra de preço
 *     alterada", sem escrever nada na loja;
 *   - preço manual (override da curadoria) fica fora por omissão; includeManual inclui-o;
 *   - pré-visualizar com rule=NET e PRICE_MODE desligada calcula NET sem mudar a regra global;
 *   - executar com uma regra diferente da do servidor recusa (RULE_MISMATCH) sem tocar na loja;
 *   - com PRICE_MODE=NET a execução escreve o preço NET e grava rule=NET na última escrita;
 *   - setManualOverride grava autor, data e motivo do preço manual.
 * Uso: node scripts/tests/published-reprice-net.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "published-reprice-net-"));
process.env.CURATION_DATA_DIR = tmp;
process.env.DATABASE_URL = `file:${path.join(tmp, "x.sqlite")}`;
delete process.env.PRICE_MODE;
const cwd = process.cwd();
process.chdir(tmp);

const q = await import(path.join(cwd, "lib/curation/curationQueue.server.js"));
const rp = await import(path.join(cwd, "lib/importer/shopify/publishedReprice.server.js"));
const { classifyRepriceRow, activeLimit } = await import(path.join(cwd, "lib/importer/pricing/publishedReprice.js"));
const { buildLastPriceWrite, changeReasons, RULE_CHANGED_REASON } = await import(path.join(cwd, "lib/importer/pricing/lastPriceWrite.js"));
const { isNetMode } = await import(path.join(cwd, "lib/importer/pricing/priceMode.js"));

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.stack?.split("\n").slice(0, 3).join("\n      ") || err.message}`);
  }
}
async function withMode(value, fn) {
  const prev = process.env.PRICE_MODE;
  if (value === undefined) delete process.env.PRICE_MODE;
  else process.env.PRICE_MODE = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.PRICE_MODE;
    else process.env.PRICE_MODE = prev;
  }
}

/** Loja falsa mínima: variante por SKU, preço editável, registo de chamadas. */
function makeShop() {
  const products = new Map();
  const calls = [];
  let n = 0;
  const byVariantId = (id) => [...products.values()].find((p) => p.variantId === id);
  const client = {
    async graphql(query, vars = {}) {
      const name = (query.match(/(?:query|mutation)\s+(\w+)/) || [])[1];
      calls.push({ name, vars });
      switch (name) {
        case "LiveVariantsBySku": {
          const skus = [...vars.query.matchAll(/sku:"([^"]+)"/g)].map((m) => m[1]);
          return {
            productVariants: {
              nodes: skus
                .map((s) => products.get(s))
                .filter(Boolean)
                .map((p) => ({ id: p.variantId, sku: p.sku, price: p.price, product: { id: p.productId, title: "x", status: "ACTIVE", syncLocked: null } })),
            },
          };
        }
        case "RepriceRecheck": {
          const p = byVariantId(vars.id);
          return { productVariant: p ? { price: p.price, product: { syncLocked: null } } : null };
        }
        case "RepriceVariantPrice": {
          const v = vars.variants[0];
          const p = byVariantId(v.id);
          p.price = v.price;
          return { productVariantsBulkUpdate: { productVariants: [{ id: p.variantId, price: p.price }], userErrors: [] } };
        }
        default:
          return {};
      }
    },
  };
  const add = (sku, price) => {
    n += 1;
    products.set(sku, { sku, productId: `gid://shopify/Product/${n}`, variantId: `gid://shopify/ProductVariant/${n}`, price });
  };
  return { client, calls, add, price: (sku) => products.get(sku)?.price, writes: () => calls.filter((c) => c.name === "RepriceVariantPrice") };
}

const deps = (over = {}) => ({
  globalPct: 10,
  pauseMs: 0,
  isSyncRunning: async () => false,
  // custo 9,99 / PVPR 17,95: LEGACY a 10 % dá 14,50 (piso 80 % do PVPR); NET dá 11,00.
  loadCatalog: async (_shop, skus) => new Map(skus.map((s) => [s, { distributorPrice: 9.99, grossPrice: 17.95 }])),
  ...over,
});
const run = (shop, over = {}) => ({ shop: "test.myshopify.com", client: shop.client, mode: "rule", deps: deps(), ...over });
const lastLegacy = (price, extra = {}) =>
  buildLastPriceWrite({ price, cost: 12.09, pvpr: 17.95, marginPct: 10, priceStatus: "PISO_PVPR", source: "publisher", rule: "LEGACY", ...extra });
async function publishedItem(sku, lastPrice, overrides) {
  await q.setManualOverride(sku, overrides || {});
  await q.markQueueItemPublished(sku, `gid://shopify/Product/${sku}`, { lastPriceWrite: lastPrice ? lastLegacy(lastPrice) : null });
}

await q.saveCurationQueue({ version: 1, items: [] });

console.log("classifyRepriceRow — regra");
const catalog = { distributorPrice: 9.99, grossPrice: 17.95 };
const item = (over = {}) => ({ sku: "G", title_en: "G", metadata: { lastPriceWrite: lastLegacy(14.5), ...over } });
const live = (price) => ({ price, variantId: "gid://shopify/ProductVariant/1", productId: "gid://shopify/Product/1" });
const classify = (over = {}) => classifyRepriceRow({ item: item(), catalog, live: live(14.5), globalPct: 10, ...over });

await check("rule=NET sobre uma escrita LEGACY: a atualizar, único motivo 'regra de preço alterada'", async () => {
  const r = classify({ rule: "NET" });
  assert.equal(r.category, "update");
  assert.equal(r.proposed, 11);
  assert.equal(r.diff, -3.5);
  assert.deepEqual(r.reasons, [RULE_CHANGED_REASON]);
  assert.equal(r.rule, "NET");
  assert.equal(r.limit, "—");
  assert.equal(isNetMode(), false, "a regra global não mudou");
});
await check("mesma regra: motivos normais (custo/margem), não 'regra alterada'", async () => {
  const r = classify({ rule: "LEGACY", live: live(14.9), item: item({ lastPriceWrite: lastLegacy(14.9, { marginPct: 20 }) }) });
  assert.equal(r.category, "update");
  assert.deepEqual(r.reasons, ["margem alterada (de 20 para 10)"]);
});
await check("changeReasons: registo sem campo rule conta como LEGACY", async () => {
  const old = { price: 14.5, cost: 12.09, pvpr: 17.95, marginPct: 10, priceStatus: "MARGEM", source: "publisher", at: new Date().toISOString() };
  assert.deepEqual(changeReasons(old, { cost: 9.99, pvpr: 17.95, marginPct: 10, rule: "NET" }), [RULE_CHANGED_REASON]);
  assert.deepEqual(changeReasons(old, { cost: 12.09, pvpr: 17.95, marginPct: 10, rule: "LEGACY" }), []);
});
await check("preço manual (override da curadoria) fica fora por omissão", async () => {
  const withOverride = item({ overrides: { price: 15.5 } });
  const r = classify({ rule: "NET", item: withOverride });
  assert.equal(r.category, "ignored");
  assert.match(r.reason, /preço manual/);
  assert.equal(r.manualOverride, true);
});
await check("includeManual inclui o produto com preço manual", async () => {
  const r = classify({ rule: "NET", item: item({ overrides: { price: 15.5 } }), includeManual: true });
  assert.equal(r.category, "update");
  assert.equal(r.manualOverride, true);
});
await check("preço manual já conforme continua conforme", async () => {
  const r = classify({ rule: "NET", item: item({ overrides: { price: 15.5 } }), live: live(11) });
  assert.equal(r.category, "conforme");
});
await check("activeLimit: NET não tem limites", async () => {
  assert.equal(activeLimit("MARGEM", 5, "NET"), "—");
  assert.equal(activeLimit("PISO_PVPR", 10, "LEGACY"), "PISO_PVPR");
});

console.log("buildRepricePreview / executeReprice");
await check("flag desligada: pré-visualizar com rule=NET calcula NET, não escreve e não muda a regra global", async () => {
  await withMode(undefined, async () => {
    const shop = makeShop();
    shop.add("N1", "14.50");
    await publishedItem("N1", 14.5);
    const p = await rp.buildRepricePreview(run(shop, { rule: "NET" }));
    assert.equal(p.rule, "NET");
    assert.equal(p.serverRule, "LEGACY");
    const r = p.rows.find((x) => x.sku === "N1");
    assert.equal(r.category, "update");
    assert.equal(r.proposed, 11);
    assert.deepEqual(r.reasons, [RULE_CHANGED_REASON]);
    assert.equal(shop.writes().length, 0);
    assert.equal(shop.price("N1"), "14.50");
    assert.equal(isNetMode(), false);
    // Sem rule: a regra do servidor (LEGACY) — o produto está conforme.
    const legacy = await rp.buildRepricePreview(run(shop));
    assert.equal(legacy.rule, "LEGACY");
    assert.equal(legacy.rows.length, 0);
  });
});
await check("execute com rule=NET e PRICE_MODE desligada: RULE_MISMATCH, nem lê nem escreve na loja", async () => {
  await withMode(undefined, async () => {
    const shop = makeShop();
    shop.add("N2", "14.50");
    await publishedItem("N2", 14.5);
    await assert.rejects(() => rp.executeReprice(run(shop, { rule: "NET", confirmCount: 1 })), (e) => e.code === "RULE_MISMATCH");
    assert.equal(shop.calls.length, 0, "nenhuma chamada à Shopify");
    assert.equal(shop.price("N2"), "14.50");
  });
});
await check("regra inválida: BAD_RULE", async () => {
  const shop = makeShop();
  await assert.rejects(() => rp.buildRepricePreview(run(shop, { rule: "ABC" })), (e) => e.code === "BAD_RULE");
  await assert.rejects(() => rp.executeReprice(run(shop, { rule: "ABC", confirmCount: 0 })), (e) => e.code === "BAD_RULE");
});
await check("PRICE_MODE=NET: mudança de regra marca todos como a atualizar; executar escreve 11,00 e grava rule=NET", async () => {
  await q.saveCurationQueue({ version: 1, items: [] });
  await withMode("NET", async () => {
    const shop = makeShop();
    shop.add("E1", "14.50");
    shop.add("E2", "14.90");
    await publishedItem("E1", 14.5);
    await publishedItem("E2", 14.9);
    const p = await rp.buildRepricePreview(run(shop));
    assert.equal(p.rule, "NET");
    assert.equal(p.totals.counts.update, 2);
    assert.equal(shop.writes().length, 0, "pré-visualização não escreve");
    const r = await rp.executeReprice(run(shop, { confirmCount: 2, rule: "NET" }));
    assert.equal(r.updated, 2);
    assert.equal(shop.price("E1"), "11.00");
    const w = (await q.getCurationQueueEntry("E1")).metadata.lastPriceWrite;
    assert.equal(w.price, 11);
    assert.equal(w.rule, "NET");
    assert.equal(w.source, "reprice");
    // Repetir: tudo conforme.
    const again = await rp.buildRepricePreview(run(shop));
    assert.equal(again.rows.length, 0);
  });
});
await check("preço manual fica fora do âmbito e da escrita por omissão; includeManual escreve", async () => {
  await q.saveCurationQueue({ version: 1, items: [] });
  await withMode("NET", async () => {
    const shop = makeShop();
    shop.add("MAN", "15.50");
    await publishedItem("MAN", 15.5, { price: 15.5 });
    const p = await rp.buildRepricePreview(run(shop, { mode: "filter", skus: ["MAN"] }));
    assert.equal(p.rows[0].category, "ignored");
    const r = await rp.executeReprice(run(shop, { mode: "filter", skus: ["MAN"], confirmCount: 1 }));
    assert.equal(r.updated, 0);
    assert.equal(r.ignored, 1);
    assert.equal(shop.writes().length, 0);
    const inc = await rp.executeReprice(run(shop, { mode: "filter", skus: ["MAN"], confirmCount: 1, includeManual: true }));
    assert.equal(inc.updated, 1);
    assert.equal(shop.price("MAN"), "11.00");
  });
});

console.log("setManualOverride — autor, data e motivo");
await check("grava priceMeta quando o preço muda; o mesmo preço preserva o registo", async () => {
  await q.saveCurationQueue({ version: 1, items: [] });
  await q.setManualOverride("PM1", { price: 12.5 }, { by: "carlos@alterpop.test", reason: "acordo com o fornecedor" });
  const m1 = (await q.getCurationQueueEntry("PM1")).metadata.overrides;
  assert.equal(m1.price, 12.5);
  assert.equal(m1.priceMeta.by, "carlos@alterpop.test");
  assert.equal(m1.priceMeta.reason, "acordo com o fornecedor");
  assert.ok(!Number.isNaN(new Date(m1.priceMeta.at).getTime()));
  // O mesmo preço por outra pessoa não é edição: o registo original fica.
  await q.setManualOverride("PM1", { price: 12.5 }, { by: "outra@alterpop.test", reason: "import CSV" });
  assert.equal((await q.getCurationQueueEntry("PM1")).metadata.overrides.priceMeta.by, "carlos@alterpop.test");
  // Preço novo: registo novo.
  await q.setManualOverride("PM1", { price: 13 }, { by: "outra@alterpop.test", reason: "import CSV" });
  const m3 = (await q.getCurationQueueEntry("PM1")).metadata.overrides;
  assert.equal(m3.priceMeta.by, "outra@alterpop.test");
  assert.equal(m3.priceMeta.reason, "import CSV");
  // Editar só o título não mexe no registo do preço.
  await q.setManualOverride("PM1", { title: "Novo título" }, { by: "x", reason: "y" });
  assert.equal((await q.getCurationQueueEntry("PM1")).metadata.overrides.priceMeta.by, "outra@alterpop.test");
});

if (failures) {
  console.error(`\n${failures} teste(s) falharam.`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
