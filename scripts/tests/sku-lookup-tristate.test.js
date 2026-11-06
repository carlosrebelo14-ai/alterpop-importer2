#!/usr/bin/env node
/**
 * Briefing 06/11/2026, PR B (D2). "Não encontrado" só com resposta válida e vazia. Falha de API entra com a
 * causa e nunca vira not_found, nem fica na cache. O ciclo regista um resumo found, not_found e error, e
 * desativa os erros "não encontrado" antigos dos SKUs que a loja agora devolve.
 * Uso: node scripts/tests/sku-lookup-tristate.test.js
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sku-lookup-"));
process.env.DATABASE_URL = `file:${path.join(dir, "t.sqlite")}`;
process.env.CURATION_DATA_DIR = dir;
execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], { cwd: ROOT, stdio: "ignore", env: process.env });

const { lookupVariantBySku, resolveVariantBySku, classifyLookupError, LOOKUP_ERROR_CAUSES } = await import("../../lib/importer/lib/resolveSku.js");
const { syncPublishedStockLevels, formatLookupSummary } = await import("../../lib/importer/shopify/publishedStockSync.server.js");
const { clearNotFoundErrorsForSkus, persistSyncError, CLEAR_NOT_FOUND_CHUNK } = await import("../../lib/importer/sync/syncErrorLog.server.js");
const { NOT_FOUND_MESSAGE } = await import("../../lib/importer/sync/syncMessages.js");
const { prisma } = await import("../../lib/prisma/prismaSafe.server.js");

const SHOP = "loja-teste.myshopify.com";
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FALHA  ${name}\n    ${err.message}`);
  }
}

const RETRY_EXHAUSTED = new Error("Shopify request failed after retries");
const nodeFor = (sku) => ({
  id: `gid://shopify/Product/${sku}`,
  title: `P ${sku}`,
  syncLockedMetafield: null,
  variants: { nodes: [{ id: `gid://shopify/ProductVariant/${sku}`, sku, price: "1.00", inventoryItem: { id: `gid://shopify/InventoryItem/${sku}` } }] },
});
/** Cliente de teste: `plan[sku]` é "found", "empty" ou "throttle" (retry esgotado). */
function mockClient(plan) {
  return {
    async graphql(query, vars) {
      if (query.includes("GetInventoryQty")) {
        return { inventoryItem: { inventoryLevel: { quantities: [{ name: "available", quantity: 5 }] } } };
      }
      const sku = vars.query.match(/sku:"(.*)"/)[1];
      const mode = plan[sku];
      if (mode === "throttle") throw RETRY_EXHAUSTED;
      if (mode === "empty") return { products: { nodes: [] } };
      return { products: { nodes: [nodeFor(sku)] } };
    },
  };
}

// C1, C2, C7
await check("resposta vazia válida é not_found e fica em cache", async () => {
  const cache = new Map();
  const r = await lookupVariantBySku(mockClient({ A: "empty" }), "A", cache);
  assert.equal(r.status, "not_found");
  assert.ok(cache.has("A") && cache.get("A") === null);
});
await check("throttle esgotado é error com a causa, nunca not_found", async () => {
  const r = await lookupVariantBySku(mockClient({ A: "throttle" }), "A", new Map());
  assert.equal(r.status, "error");
  assert.equal(r.cause, LOOKUP_ERROR_CAUSES.RETRY_EXHAUSTED);
});
await check("error nunca entra na cache (C7)", async () => {
  const cache = new Map();
  await lookupVariantBySku(mockClient({ A: "throttle" }), "A", cache);
  assert.equal(cache.has("A"), false);
});
await check("resposta sem products.nodes é error, não not_found", async () => {
  const r = await lookupVariantBySku({ graphql: async () => ({}) }, "A", new Map());
  assert.equal(r.status, "error");
  assert.equal(r.cause, LOOKUP_ERROR_CAUSES.BAD_RESPONSE);
});
await check("produto sem variantes legíveis é error, não not_found", async () => {
  const client = { graphql: async () => ({ products: { nodes: [{ id: "p", title: "t", variants: { nodes: [] } }] } }) };
  assert.equal((await lookupVariantBySku(client, "A", new Map())).status, "error");
});
await check("causas de erro HTTP e timeout classificadas", () => {
  assert.equal(classifyLookupError(new Error('Shopify HTTP 401: {"errors":"x"}')), LOOKUP_ERROR_CAUSES.HTTP_AUTH);
  assert.equal(classifyLookupError(new Error("Shopify HTTP 404: x")), LOOKUP_ERROR_CAUSES.HTTP_4XX);
  assert.equal(classifyLookupError(new Error("Shopify HTTP 503: x")), LOOKUP_ERROR_CAUSES.HTTP_5XX);
  assert.equal(classifyLookupError(Object.assign(new Error("t"), { code: "SHOPIFY_TIMEOUT" })), LOOKUP_ERROR_CAUSES.TIMEOUT);
  assert.equal(classifyLookupError(new TypeError("fetch failed")), LOOKUP_ERROR_CAUSES.NETWORK);
});
await check("resolveVariantBySku lança em erro e devolve null só em not_found (o publisher não duplica produtos)", async () => {
  await assert.rejects(() => resolveVariantBySku(mockClient({ A: "throttle" }), "A", new Map()), (e) => e.code === "SKU_LOOKUP_FAILED");
  assert.equal(await resolveVariantBySku(mockClient({ A: "empty" }), "A", new Map()), null);
  assert.equal((await resolveVariantBySku(mockClient({ A: "found" }), "A", new Map())).sku, "A");
});

// Ciclo de stock, de ponta a ponta, com throttle esgotado a meio do lote.
const SKUS = ["S1", "S2", "S3", "S4", "S5", "S6"];
fs.writeFileSync(
  path.join(dir, "curation-queue.json"),
  JSON.stringify({ version: 1, items: SKUS.map((sku) => ({ sku, title_en: sku, status: "PUBLISHED", metadata: {} })) })
);
for (const sku of SKUS) await prisma.catalogProduct.create({ data: { shop: SHOP, sku, title: sku, stock: 5 } });

let result;
await check("ciclo com throttle esgotado a meio: nenhum SKU vira not_found por causa do throttle", async () => {
  const plan = { S1: "found", S2: "found", S3: "throttle", S4: "throttle", S5: "empty", S6: "found" };
  result = await syncPublishedStockLevels(mockClient(plan), SHOP, { locationId: "gid://shopify/Location/1" });
  assert.equal(result.lookup.found, 3);
  assert.equal(result.lookup.notFound, 1, "só o S5, resposta vazia válida");
  assert.deepEqual(result.lookup.errorByCause, { [LOOKUP_ERROR_CAUSES.RETRY_EXHAUSTED]: 2 });
  const notFoundMsgs = result.failures.filter((f) => f.message === NOT_FOUND_MESSAGE).map((f) => f.sku);
  assert.deepEqual(notFoundMsgs, ["S5"]);
  const apiMsgs = result.failures.filter((f) => f.message.startsWith("Falha de API")).map((f) => f.sku);
  assert.deepEqual(apiMsgs.sort(), ["S3", "S4"]);
  assert.ok(result.failures.find((f) => f.sku === "S3").message.includes(LOOKUP_ERROR_CAUSES.RETRY_EXHAUSTED));
  assert.deepEqual(result.foundSkus, ["S1", "S2", "S6"]);
});
await check("resumo do ciclo tem as contagens e nenhum SKU (C8)", () => {
  const line = formatLookupSummary(result);
  assert.ok(line.includes("3 found") && line.includes("1 not_found") && line.includes("2 error") && line.includes("retry_esgotado=2"), line);
  assert.ok(!/S\d/.test(line.replace("retry_esgotado", "")), "o resumo não pode ter SKUs");
});
await check("no ciclo seguinte os SKUs que falharam por throttle voltam a ser tentados (sem cache de erro)", async () => {
  const again = await syncPublishedStockLevels(mockClient({ S1: "found", S2: "found", S3: "found", S4: "found", S5: "empty", S6: "found" }), SHOP, { locationId: "gid://shopify/Location/1" });
  assert.equal(again.lookup.found, 5);
  assert.deepEqual(again.lookup.errorByCause, {});
});

// C6
await check("erros antigos 'não encontrado' dos SKUs encontrados ficam inativos; outros erros ficam", async () => {
  await persistSyncError({ shop: SHOP, sku: "S1", reason: NOT_FOUND_MESSAGE });
  await persistSyncError({ shop: SHOP, sku: "S2", reason: NOT_FOUND_MESSAGE });
  await persistSyncError({ shop: SHOP, sku: "S2", reason: "Shopify HTTP 401: sem acesso" });
  await persistSyncError({ shop: SHOP, sku: "S5", reason: NOT_FOUND_MESSAGE });
  const cleared = await clearNotFoundErrorsForSkus(SHOP, ["S1", "S2"]);
  assert.equal(cleared, 2);
  const active = await prisma.syncErrorLog.findMany({ where: { shop: SHOP, active: true }, orderBy: { sku: "asc" } });
  assert.deepEqual(active.map((r) => `${r.sku}:${r.message.slice(0, 12)}`), ["S2:Shopify HTTP", "S5:Produto/vari"]);
});
await check("o bloco do updateMany é uma constante nomeada", () => assert.equal(typeof CLEAR_NOT_FOUND_CHUNK, "number"));
await check("o ciclo de stock usa lookupVariantBySku e desativa os antigos (estático)", () => {
  const stock = fs.readFileSync(path.join(ROOT, "lib/importer/shopify/publishedStockSync.server.js"), "utf8");
  assert.ok(stock.includes("lookupVariantBySku(client, sku, variantCache)"));
  const trigger = fs.readFileSync(path.join(ROOT, "app/routes/api.trigger-sync.jsx"), "utf8");
  assert.ok(trigger.includes("clearNotFoundErrorsForSkus(shop, stockResult.foundSkus") && trigger.includes("formatLookupSummary(stockResult)"));
});
await check("C5: o limite de retry do cliente é constante nomeada", () => {
  const client = fs.readFileSync(path.join(ROOT, "lib/importer/shopifyClient.js"), "utf8");
  assert.ok(/^const MAX_RETRIES = \d+;/m.test(client));
  assert.ok(client.includes("attempt < MAX_RETRIES"));
});

await prisma.$disconnect();
if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nsku-lookup-tristate: todos os testes passaram");
