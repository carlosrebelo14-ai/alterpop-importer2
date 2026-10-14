#!/usr/bin/env node
/* eslint-env node */
/**
 * price_check (lib/importer/pricing/priceCheck.server.js): lê taxesIncluded e os preços dos publicados,
 * compara com a regra NET, devolve SÓ contagens. Loja falsa, sem rede.
 * Uso: node scripts/tests/price-check.test.js
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_URL = `file:${path.join(os.tmpdir(), "price-check-unused.sqlite")}`;
delete process.env.PRICE_MODE;
const { runPriceCheck, formatPriceCheck, ignoreKind } = await import(path.join(process.cwd(), "lib/importer/pricing/priceCheck.server.js"));
const { buildLastPriceWrite } = await import(path.join(process.cwd(), "lib/importer/pricing/lastPriceWrite.js"));

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.stack?.split("\n").slice(0, 3).join("\n      ")}`);
  }
}

const lw = (price) => buildLastPriceWrite({ price, cost: 9.99, pvpr: 17.95, marginPct: 10, priceStatus: "MARGEM", source: "reprice" });
const item = (sku, over = {}, lastPrice = null) => ({
  sku,
  title_en: `Titulo ${sku}`,
  status: "PUBLISHED",
  metadata: { shopifyProductId: `gid://shopify/Product/${sku}`, ...(lastPrice == null ? {} : { lastPriceWrite: lw(lastPrice) }), ...over },
});
const liveOf = (price, over = {}) => ({ price, variantId: "v", productId: "p", ...over });

// NET com margem global 10 sobre custo 9,99 → 11,00
const items = [
  item("CONF", {}, 11), // conforme
  item("DESCE", {}, 14.5), // 14,50 → 11,00 (−24 %)
  item("SOBE", {}, 10), // 10,00 → 11,00 (+10 %)
  item("OVR", { overrides: { price: 15.5 } }, 15.5), // override da curadoria
  item("DET", {}, 14.9), // loja 12,00 ≠ última escrita 14,90 → manual detetado
  item("LOCK", {}, 14.5), // trancado
  item("SEMREG", {}), // sem última escrita
  item("SUMIU", {}, 11), // sem variante live, produto inexistente
  item("FALHA", { shopifyProductId: null }, 11), // sem variante live nem id
];
const liveBySku = new Map([
  ["CONF", liveOf(11)],
  ["DESCE", liveOf(14.5)],
  ["SOBE", liveOf(10)],
  ["OVR", liveOf(15.5)],
  ["DET", liveOf(12)],
  ["LOCK", liveOf(14.5, { syncLocked: true })],
  ["SEMREG", liveOf(14.5)],
]);
const catalog = { distributorPrice: 9.99, grossPrice: 17.95 };
const deps = {
  loadQueue: async () => ({ items }),
  globalPct: 10,
  loadCatalog: async () => new Map(items.map((i) => [i.sku, catalog])),
  fetchLive: async () => liveBySku,
};
function fakeClient(taxesIncluded) {
  const calls = [];
  return {
    calls,
    async graphql(query) {
      calls.push(query);
      if (/mutation/i.test(query)) throw new Error("price_check nunca escreve");
      if (/PriceCheckShop/.test(query)) return { shop: { taxesIncluded } };
      return { product: null }; // PRODUCT_EXISTS
    },
  };
}

await check("contagens: conformes, a atualizar (sobem/descem/bandas), fora por preço manual, trancados, falhados", async () => {
  const client = fakeClient(true);
  const r = await runPriceCheck({ shop: "x.myshopify.com", client, deps });
  assert.equal(r.serverRule, "LEGACY");
  assert.equal(r.taxesIncluded, true);
  assert.equal(r.published, 9);
  assert.equal(r.conformesNet, 1);
  assert.equal(r.aAtualizar, 2);
  assert.equal(r.sobem, 1);
  assert.equal(r.descem, 1);
  assert.deepEqual(r.bands, { ate_1: 0, "1_a_5": 0, "5_a_15": 1, acima_15: 1 });
  assert.equal(r.foraPorPrecoManual, 2);
  assert.equal(r.manualOverride, 1);
  assert.equal(r.manualDetetado, 1);
  assert.equal(r.trancados, 1);
  assert.equal(r.semRegisto, 1);
  assert.equal(r.naoEncontrados, 1);
  assert.equal(r.falhados, 1);
});
await check("só leitura: nenhuma mutation", async () => {
  const client = fakeClient(false);
  await runPriceCheck({ shop: "x.myshopify.com", client, deps });
  assert.ok(!client.calls.some((q) => /mutation/i.test(q)));
});
await check("a saída só tem linhas PC: com contagens, sem SKUs, títulos, preços nem GIDs", async () => {
  const r = await runPriceCheck({ shop: "x.myshopify.com", client: fakeClient(true), deps });
  const out = formatPriceCheck(r).join("\n");
  for (const line of out.split("\n")) assert.match(line, /^PC: [a-z_0-9]+=[A-Za-z0-9_.-]+$/);
  assert.doesNotMatch(out, /CONF|DESCE|SOBE|Titulo|gid:|€|11,00|14,50/);
  assert.match(out, /impostos_incluidos=true/);
  assert.match(out, /fora_preco_manual=2/);
});
await check("taxesIncluded em falta falha (nunca assume)", async () => {
  const client = { async graphql() { return { shop: {} }; } };
  await assert.rejects(() => runPriceCheck({ shop: "x", client, deps }), /taxesIncluded/);
});
await check("ignoreKind funciona com o texto do motivo (código antigo na Fly, sem ignoreCode)", () => {
  assert.equal(ignoreKind({ reason: "preço manual preservado (override da curadoria)" }), "manualOverride");
  assert.equal(ignoreKind({ reason: "preço manual preservado" }), "manualDetected");
  assert.equal(ignoreKind({ reason: "produto trancado (ociostock.sync_locked) — preço preservado" }), "locked");
  assert.equal(ignoreKind({ reason: "sem última escrita registada — não se sabe se o preço é da app" }), "noRecord");
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nprice-check: todos os casos passaram");
process.exit(0);
