#!/usr/bin/env node
/**
 * "Aplicar aos publicados", passos 4, 6, 7 e 8 — pré-visualização e execução contra uma
 * loja Shopify falsa (sem rede) e uma fila temporária:
 *   - pré-visualização não escreve nada; o Gandalf mostra 14,90 → 14,50 (−0,40 €);
 *   - recusa: sem confirmação, âmbito diferente do confirmado, ciclo de sync a correr;
 *   - cinco categorias somam o âmbito; releitura diferente = falhado;
 *   - repetir com tudo conforme: zero atualizados, zero escritas;
 *   - produto editado no admin fica em "ignorados"; apagado volta a PENDING, nunca APPROVED.
 * Uso: node scripts/tests/published-reprice.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "published-reprice-"));
process.env.CURATION_DATA_DIR = tmp;
process.env.DATABASE_URL = `file:${path.join(tmp, "x.sqlite")}`;
const cwd = process.cwd();
process.chdir(tmp); // results/errors.json do módulo cai aqui

const q = await import(path.join(cwd, "lib/curation/curationQueue.server.js"));
const rp = await import(path.join(cwd, "lib/importer/shopify/publishedReprice.server.js"));
const { buildLastPriceWrite } = await import(path.join(cwd, "lib/importer/pricing/lastPriceWrite.js"));

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

/** Loja falsa: variante por SKU, preço editável, registo de chamadas. */
function makeShop() {
  const products = new Map();
  const calls = [];
  const hooks = { beforeRecheck: null, ignoreWrites: new Set(), userErrorFor: new Set() };
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
                .filter((p) => p && !p.deleted)
                .map((p) => ({ id: p.variantId, sku: p.sku, price: p.price, product: { id: p.productId, title: "x", status: "ACTIVE", syncLocked: p.locked ? { value: "true" } : null } })),
            },
          };
        }
        case "RepriceProductExists": {
          const p = [...products.values()].find((x) => x.productId === vars.id);
          return { product: p && !p.deleted ? { id: p.productId } : null };
        }
        case "RepriceRecheck": {
          const p = byVariantId(vars.id);
          if (hooks.beforeRecheck) hooks.beforeRecheck(p);
          return { productVariant: p ? { price: p.price, product: { syncLocked: p.locked ? { value: "true" } : null } } : null };
        }
        case "RepriceVariantPrice": {
          const v = vars.variants[0];
          const p = byVariantId(v.id);
          if (hooks.userErrorFor.has(p.sku)) return { productVariantsBulkUpdate: { productVariants: [], userErrors: [{ field: ["price"], message: "Price is invalid" }] } };
          if (!hooks.ignoreWrites.has(p.sku)) p.price = v.price;
          return { productVariantsBulkUpdate: { productVariants: [{ id: p.variantId, price: p.price }], userErrors: [] } };
        }
        default:
          return {};
      }
    },
  };
  const add = (sku, price, extra = {}) => {
    n += 1;
    products.set(sku, { sku, productId: `gid://shopify/Product/${n}`, variantId: `gid://shopify/ProductVariant/${n}`, price, ...extra });
  };
  const writes = () => calls.filter((c) => c.name === "RepriceVariantPrice");
  return { client, products, calls, hooks, add, writes, price: (sku) => products.get(sku)?.price };
}

const catalog = new Map(); // todos com o custo/PVPR do Gandalf: 9,99 / 17,95
const deps = (over = {}) => ({
  globalPct: 10,
  pauseMs: 0,
  isSyncRunning: async () => false,
  loadCatalog: async (_shop, skus) => new Map(skus.map((s) => [s, catalog.get(s) || { distributorPrice: 9.99, grossPrice: 17.95 }])),
  ...over,
});

const last = (price, extra = {}) => buildLastPriceWrite({ price, cost: 12.09, pvpr: 17.95, marginPct: 20, priceStatus: "MARGEM", source: "backfill", ...extra });
async function publishedItem(sku, lastPrice, productId) {
  await q.setManualOverride(sku, {});
  const entry = await q.getCurationQueueEntry(sku);
  await q.markQueueItemPublished(sku, productId ?? `gid://shopify/Product/${sku}`, { lastPriceWrite: lastPrice ? last(lastPrice) : null });
  return entry;
}
const run = (shop, over = {}) => ({ shop: "test.myshopify.com", client: shop.client, mode: "rule", deps: deps(), ...over });

await q.saveCurationQueue({ version: 1, items: [] });

console.log("Pré-visualização");
await check("Gandalf: loja 14,90, proposto 14,50, −0,40 €, −2,7 %, motivo e limite; nada escrito", async () => {
  const shop = makeShop();
  shop.add("G1", "14.90");
  await publishedItem("G1", 14.9);
  const p = await rp.buildRepricePreview(run(shop));
  const r = p.rows.find((x) => x.sku === "G1");
  assert.equal(r.category, "update");
  assert.equal(r.livePrice, 14.9);
  assert.equal(r.proposed, 14.5);
  assert.equal(r.diff, -0.4);
  assert.equal(Math.round(r.diffPct * 10) / 10, -2.7);
  assert.deepEqual(r.reasons, ["margem alterada (de 20 para 10)"]);
  assert.equal(r.limit, "PISO_PVPR");
  assert.equal(shop.writes().length, 0);
  assert.equal(shop.price("G1"), "14.90");
});

console.log("Recusas");
await check("sem confirmação, âmbito diferente do confirmado, ou ciclo a correr: recusa e não escreve", async () => {
  const shop = makeShop();
  shop.add("R1", "14.90");
  await publishedItem("R1", 14.9);
  await assert.rejects(() => rp.executeReprice(run(shop)), (e) => e.code === "CONFIRM_REQUIRED");
  const scope = (await rp.buildRepricePreview(run(shop))).rows.length;
  await assert.rejects(() => rp.executeReprice(run(shop, { confirmCount: scope + 1 })), (e) => e.code === "SCOPE_CHANGED" && e.now === scope);
  const before = shop.calls.length;
  await assert.rejects(
    () => rp.executeReprice(run(shop, { confirmCount: scope, deps: deps({ isSyncRunning: async () => true }) })),
    (e) => e.code === "SYNC_RUNNING"
  );
  assert.equal(shop.calls.length, before, "com sync a correr nem lê a loja");
  assert.equal(shop.writes().length, 0);
});

console.log("Execução");
await q.saveCurationQueue({ version: 1, items: [] });
await check("atualiza, relê e grava a última escrita; repetir dá zero atualizados e zero escritas", async () => {
  const shop = makeShop();
  shop.add("E1", "14.90");
  await publishedItem("E1", 14.9);
  const scope = (await rp.buildRepricePreview(run(shop))).rows.length;
  assert.equal(scope, 1);
  const r1 = await rp.executeReprice(run(shop, { confirmCount: scope }));
  assert.equal(r1.updated, 1);
  assert.equal(r1.scope, 1);
  assert.equal(shop.price("E1"), "14.50");
  const w = (await q.getCurationQueueEntry("E1")).metadata.lastPriceWrite;
  assert.equal(w.price, 14.5);
  assert.equal(w.source, "reprice");
  assert.equal(w.marginPct, 10);
  assert.equal(w.priceStatus, "PISO_PVPR");
  assert.equal(shop.writes().length, 1);

  // Segunda corrida: tudo conforme → âmbito 0, zero atualizados, zero escritas.
  const scope2 = (await rp.buildRepricePreview(run(shop))).rows.length;
  assert.equal(scope2, 0);
  const r2 = await rp.executeReprice(run(shop, { confirmCount: 0 }));
  assert.equal(r2.updated, 0);
  assert.equal(r2.scope, 0);
  assert.equal(shop.writes().length, 1, "a segunda corrida não escreveu");
});

await check("preço editado no admin fica em ignorados e não é tocado", async () => {
  const shop = makeShop();
  shop.add("M1", "15.50"); // a app escreveu 14,90; alguém pôs 15,50 à mão
  await publishedItem("M1", 14.9);
  const r = await rp.executeReprice(run(shop, { mode: "filter", skus: ["M1"], confirmCount: 1 }));
  assert.equal(r.ignored, 1);
  assert.equal(r.updated, 0);
  assert.equal(r.rows[0].error, "preço manual preservado");
  assert.equal(shop.price("M1"), "15.50");
  assert.equal(shop.writes().length, 0);
  assert.equal((await q.getCurationQueueEntry("M1")).metadata.lastPriceWrite.price, 14.9);
});

await check("cinco categorias somam o âmbito (âmbito do filtro, conformes incluídos)", async () => {
  const shop = makeShop();
  shop.add("C-UP", "14.90");
  shop.add("C-OK", "14.50");
  shop.add("C-MAN", "15.50");
  shop.add("C-GONE", "14.90", { deleted: true, productId: "gid://shopify/Product/GONE" });
  shop.add("C-FAIL", "14.90");
  shop.hooks.userErrorFor.add("C-FAIL");
  await publishedItem("C-UP", 14.9);
  await publishedItem("C-OK", 14.5);
  await publishedItem("C-MAN", 14.9);
  await publishedItem("C-GONE", 14.9, "gid://shopify/Product/GONE");
  await publishedItem("C-FAIL", 14.9);
  const skus = ["C-UP", "C-OK", "C-MAN", "C-GONE", "C-FAIL"];
  const r = await rp.executeReprice(run(shop, { mode: "filter", skus, confirmCount: 5 }));
  assert.equal(r.scope, 5);
  assert.deepEqual([r.updated, r.conformes, r.ignored, r.notFound, r.failed], [1, 1, 1, 1, 1]);
  assert.equal(r.updated + r.conformes + r.ignored + r.notFound + r.failed, r.scope);
  assert.equal(shop.price("C-UP"), "14.50");
  assert.equal(shop.price("C-FAIL"), "14.90");
  assert.match(r.rows.find((x) => x.sku === "C-FAIL").error, /Price is invalid/);
});

await check("apagado na loja volta a PENDING com nota e data; nunca APPROVED; sem escrita", async () => {
  const gone = await q.getCurationQueueEntry("C-GONE");
  assert.equal(gone.status, "PENDING");
  assert.equal(gone.metadata.wasPublished, true);
  assert.equal(gone.metadata.deletedInAdmin.note, "apagado no admin");
  assert.ok(!Number.isNaN(new Date(gone.metadata.deletedInAdmin.at).getTime()));
  assert.equal(gone.metadata.shopifyProductId, undefined);
  assert.notEqual(gone.status, "APPROVED");
});

await check("releitura diferente: contado como falhado, última escrita não gravada", async () => {
  const shop = makeShop();
  shop.add("RL1", "14.90");
  shop.hooks.ignoreWrites.add("RL1"); // a loja aceita mas não aplica
  await publishedItem("RL1", 14.9);
  const r = await rp.executeReprice(run(shop, { mode: "filter", skus: ["RL1"], confirmCount: 1 }));
  assert.equal(r.failed, 1);
  assert.equal(r.updated, 0);
  assert.match(r.rows[0].error, /releitura diferente/);
  assert.equal((await q.getCurationQueueEntry("RL1")).metadata.lastPriceWrite.price, 14.9);
});

await check("preço mudou na loja entre a pré-visualização e a escrita: preservado, não escreve", async () => {
  const shop = makeShop();
  shop.add("CS1", "14.90");
  await publishedItem("CS1", 14.9);
  shop.hooks.beforeRecheck = (p) => {
    if (p.sku === "CS1") p.price = "16.00"; // alguém editou no admin a meio
  };
  const r = await rp.executeReprice(run(shop, { mode: "filter", skus: ["CS1"], confirmCount: 1 }));
  assert.equal(r.ignored, 1);
  assert.equal(shop.writes().length, 0);
  assert.equal(shop.price("CS1"), "16.00");
});

await check("acima de 50 produtos continua a exigir o número exato", async () => {
  const shop = makeShop();
  const skus = [];
  for (let i = 0; i < 51; i += 1) {
    const sku = `BIG-${i}`;
    skus.push(sku);
    shop.add(sku, "14.90");
    await publishedItem(sku, 14.9);
  }
  await assert.rejects(() => rp.executeReprice(run(shop, { mode: "filter", skus, confirmCount: 50 })), (e) => e.code === "SCOPE_CHANGED" && e.now === 51);
  assert.equal(shop.writes().length, 0);
  const r = await rp.executeReprice(run(shop, { mode: "filter", skus, confirmCount: 51 }));
  assert.equal(r.updated, 51);
});

process.chdir(cwd);
fs.rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
