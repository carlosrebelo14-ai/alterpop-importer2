#!/usr/bin/env node
/* eslint-env node */
/**
 * Decisão 31 — observação manual de preço de mercado (Worten, Fnac):
 *   - validação do corpo (preço, loja, data, SKU);
 *   - gravação só para SKUs do catálogo indexado; o painel mostra a observação mais recente;
 *   - o preço observado tem IVA e o Alterpop não: NENHUM campo de diferença em lado nenhum;
 *   - a rota recusa métodos que não POST e JSON inválido.
 * Usa uma BD SQLite temporária criada com `prisma db push`.
 * Uso: node scripts/tests/market-price.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "market-price-"));
process.env.DATABASE_URL = `file:${path.join(tmp, "x.sqlite")}`;
execFileSync(path.join(cwd, "node_modules/.bin/prisma"), ["db", "push", "--skip-generate"], { cwd, env: process.env, stdio: "pipe" });

const {
  parseMarketObservation,
  marketView,
  latestObservationBySku,
  MarketPriceError,
  MARKET_STORE_SUGGESTIONS,
} = await import(path.join(cwd, "lib/importer/pricing/marketPrice.js"));
const svc = await import(path.join(cwd, "lib/importer/pricing/marketPrice.server.js"));
const { prisma } = await import(path.join(cwd, "lib/prisma/prismaSafe.server.js"));

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
const NOW = new Date("2026-10-13T12:00:00Z");
const SHOP = "test.myshopify.com";

console.log("parseMarketObservation");
await check("lojas de referência sugeridas: Worten e Fnac", () => assert.deepEqual([...MARKET_STORE_SUGGESTIONS], ["Worten", "Fnac"]));
await check("corpo válido (preço em euros → cêntimos, vírgula decimal aceite)", () => {
  const o = parseMarketObservation({ sku: " A1 ", price: "12,99", store: " Worten ", observedAt: "2026-10-10" }, NOW);
  assert.deepEqual({ sku: o.sku, priceCents: o.priceCents, store: o.store }, { sku: "A1", priceCents: 1299, store: "Worten" });
  assert.equal(o.observedAt.toISOString().slice(0, 10), "2026-10-10");
  assert.equal(parseMarketObservation({ sku: "A", price: 19.9, store: "Fnac" }, NOW).priceCents, 1990);
});
await check("sem data: agora", () => assert.equal(parseMarketObservation({ sku: "A", price: 5, store: "Fnac" }, NOW).observedAt.getTime(), NOW.getTime()));
await check("rejeita SKU, preço, loja e data inválidos", () => {
  const bad = [
    {},
    { sku: "A", price: 0, store: "Fnac" },
    { sku: "A", price: -3, store: "Fnac" },
    { sku: "A", price: "abc", store: "Fnac" },
    { sku: "A", price: "", store: "Fnac" },
    { sku: "A", price: 1.234, store: "Fnac" },
    { sku: "A", price: 1e9, store: "Fnac" },
    { sku: "A", price: 5, store: "  " },
    { sku: "A", price: 5, store: "x".repeat(61) },
    { sku: "A", price: 5, store: "Fnac", observedAt: "lixo" },
    { sku: "A", price: 5, store: "Fnac", observedAt: "2027-01-01" },
    { sku: "", price: 5, store: "Fnac" },
  ];
  for (const b of bad) assert.throws(() => parseMarketObservation(b, NOW), MarketPriceError, JSON.stringify(b));
  assert.throws(() => parseMarketObservation(null, NOW), MarketPriceError);
});

console.log("vista e observação mais recente");
await check("marketView: com IVA, sem qualquer campo de diferença", () => {
  const v = marketView({ priceCents: 1299, store: "Worten", observedAt: new Date("2026-10-10T00:00:00Z") });
  assert.deepEqual(Object.keys(v).sort(), ["observedAt", "price", "priceCents", "store", "vatIncluded"]);
  assert.equal(v.vatIncluded, true);
  assert.equal(v.price, 12.99);
  assert.ok(!JSON.stringify(v).toLowerCase().includes("diff"));
});
await check("a mais recente por data observada; desempate pelo último registo", () => {
  const rows = [
    { sku: "A", priceCents: 1000, store: "Worten", observedAt: "2026-10-01", createdAt: "2026-10-01T10:00:00Z" },
    { sku: "A", priceCents: 1100, store: "Fnac", observedAt: "2026-10-05", createdAt: "2026-10-05T10:00:00Z" },
    { sku: "A", priceCents: 1200, store: "Worten", observedAt: "2026-10-03", createdAt: "2026-10-06T10:00:00Z" },
    { sku: "B", priceCents: 500, store: "Fnac", observedAt: "2026-10-05", createdAt: "2026-10-05T09:00:00Z" },
    { sku: "B", priceCents: 600, store: "Worten", observedAt: "2026-10-05", createdAt: "2026-10-05T11:00:00Z" },
  ];
  const m = latestObservationBySku(rows);
  assert.equal(m.get("A").priceCents, 1100);
  assert.equal(m.get("B").priceCents, 600);
});

console.log("gravação");
await prisma.catalogProduct.create({ data: { shop: SHOP, sku: "M1", title: "Produto" } });
await check("grava e devolve a vista; SKU fora do catálogo → NOT_FOUND", async () => {
  const r = await svc.recordMarketObservation(SHOP, { sku: "M1", price: "12,99", store: "Worten", observedAt: "2026-10-10" }, { createdBy: "carlos@alterpop.test", now: NOW });
  assert.equal(r.priceCents, 1299);
  assert.equal(r.vatIncluded, true);
  const row = await prisma.marketPriceObservation.findFirst({ where: { shop: SHOP, sku: "M1" } });
  assert.equal(row.createdBy, "carlos@alterpop.test");
  await assert.rejects(
    () => svc.recordMarketObservation(SHOP, { sku: "NAO-EXISTE", price: 5, store: "Fnac" }, { now: NOW }),
    (e) => e instanceof MarketPriceError && e.code === "NOT_FOUND"
  );
  await assert.rejects(() => svc.recordMarketObservation("outra.myshopify.com", { sku: "M1", price: 5, store: "Fnac" }, { now: NOW }), (e) => e.code === "NOT_FOUND");
});
await check("várias observações: o painel lê a mais recente, por bloco de SKUs", async () => {
  await svc.recordMarketObservation(SHOP, { sku: "M1", price: 13.5, store: "Fnac", observedAt: "2026-10-12" }, { now: NOW });
  await svc.recordMarketObservation(SHOP, { sku: "M1", price: 11, store: "Worten", observedAt: "2026-10-01" }, { now: NOW });
  const map = await svc.getLatestMarketBySkus(SHOP, ["M1", "M2"]);
  assert.equal(map.get("M1").priceCents, 1350);
  assert.equal(map.get("M1").store, "Fnac");
  assert.equal(map.has("M2"), false, "sem observação → sem entrada (campo opcional)");
});

console.log("rota");
const routeSrc = fs.readFileSync(path.join(cwd, "app/routes/api.market-prices.manual.jsx"), "utf8");
await check("a rota só aceita POST, valida o JSON e não calcula diferenças", () => {
  assert.match(routeSrc, /request\.method !== "POST"/);
  assert.match(routeSrc, /status: 405/);
  assert.match(routeSrc, /JSON inválido/);
  assert.match(routeSrc, /NOT_FOUND/);
  assert.ok(!/diff/i.test(routeSrc.replace(/diferença/gi, "").replace(/diferenças/gi, "")), "a rota não calcula diferenças");
});

await prisma.$disconnect();
if (failures) {
  console.error(`\n${failures} teste(s) falharam.`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
