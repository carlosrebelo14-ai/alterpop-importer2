#!/usr/bin/env node
/* eslint-env node */
/**
 * Decisão 31 — histórico de preços e mínimo Omnibus dos 30 dias:
 *   - omnibusMinCents: janela, preço vigente no início da janela, histórico vazio, e só
 *     entradas da regra em vigor (LEGACY e NET nunca se misturam);
 *   - recordLastPriceWrites grava PriceHistory com a regra e a data (o backfill não entra),
 *     e uma falha do histórico não desfaz a última escrita: vem em historyError;
 *   - getOmnibusMinBySkus lê da BD por regra.
 * Usa uma BD SQLite temporária criada com `prisma db push`.
 * Uso: node scripts/tests/price-history-omnibus.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const cwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "price-history-"));
process.env.CURATION_DATA_DIR = tmp;
process.env.DATABASE_URL = `file:${path.join(tmp, "x.sqlite")}`;
delete process.env.PRICE_MODE;
execFileSync(path.join(cwd, "node_modules/.bin/prisma"), ["db", "push", "--skip-generate"], {
  cwd,
  env: process.env,
  stdio: "pipe",
});
process.chdir(tmp);

const { omnibusMinCents, OMNIBUS_WINDOW_DAYS } = await import(path.join(cwd, "lib/importer/pricing/omnibus.js"));
const q = await import(path.join(cwd, "lib/curation/curationQueue.server.js"));
const hist = await import(path.join(cwd, "lib/importer/pricing/priceHistory.server.js"));
const { buildLastPriceWrite } = await import(path.join(cwd, "lib/importer/pricing/lastPriceWrite.js"));
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

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-13T12:00:00Z");
const ago = (days) => new Date(NOW.getTime() - days * DAY);
const e = (priceCents, daysAgo, rule = "NET") => ({ priceCents, rule, at: ago(daysAgo) });

console.log("omnibusMinCents");
await check("janela de 30 dias", () => assert.equal(OMNIBUS_WINDOW_DAYS, 30));
await check("sem histórico (ou sem a regra pedida) → null", () => {
  assert.equal(omnibusMinCents([], NOW, "NET"), null);
  assert.equal(omnibusMinCents([e(1100, 5, "LEGACY")], NOW, "NET"), null);
});
await check("mínimo das entradas dentro da janela", () => {
  assert.equal(omnibusMinCents([e(1500, 20), e(1200, 10), e(1400, 2)], NOW, "NET"), 1200);
});
await check("o preço vigente no início da janela conta (entrada anterior aos 30 dias)", () => {
  // 9,00 € desde há 90 dias, subiu para 15,00 € há 5 dias: nos últimos 30 dias o mínimo é 9,00 €.
  assert.equal(omnibusMinCents([e(900, 90), e(1500, 5)], NOW, "NET"), 900);
});
await check("só a última entrada anterior à janela conta, não as mais antigas", () => {
  // 5,00 € há 200 dias, 9,00 € há 90 dias (vigente no início da janela), 15,00 € há 5 dias.
  assert.equal(omnibusMinCents([e(500, 200), e(900, 90), e(1500, 5)], NOW, "NET"), 900);
});
await check("um único preço antigo, ainda em vigor, é o mínimo", () => {
  assert.equal(omnibusMinCents([e(1100, 120)], NOW, "NET"), 1100);
});
await check("ordem de entrada irrelevante; entradas futuras e inválidas ignoradas", () => {
  const list = [e(1400, 2), e(900, 90), e(1500, 5), e(100, -3), { priceCents: -5, rule: "NET", at: ago(1) }, { priceCents: 700, rule: "NET", at: "lixo" }];
  assert.equal(omnibusMinCents(list, NOW, "NET"), 900);
});
await check("LEGACY (com IVA) e NET (sem IVA) nunca se misturam", () => {
  const list = [e(1450, 20, "LEGACY"), e(1100, 3, "NET")];
  assert.equal(omnibusMinCents(list, NOW, "NET"), 1100);
  assert.equal(omnibusMinCents(list, NOW, "LEGACY"), 1450);
  // O preço vigente no início da janela também é só da mesma regra.
  assert.equal(omnibusMinCents([e(800, 90, "LEGACY"), e(1100, 3, "NET")], NOW, "NET"), 1100);
});
await check("data inválida em now lança", () => assert.throws(() => omnibusMinCents([], "lixo", "NET")));

console.log("recordLastPriceWrites → PriceHistory");
const SHOP = "test.myshopify.com";
const write = (price, over = {}) =>
  buildLastPriceWrite({ price, cost: 9.99, pvpr: 17.95, marginPct: 10, priceStatus: "MARGEM", source: "publisher", ...over });
await q.saveCurationQueue({ version: 1, items: [] });
await q.setManualOverride("H1", {});

await check("grava preço (cêntimos), regra, origem e data", async () => {
  const w = write(11, { rule: "NET", at: "2026-10-12T10:00:00Z" });
  const r = await q.recordLastPriceWrites([{ sku: "H1", write: w }], { shop: SHOP });
  assert.deepEqual(r.recorded, ["H1"]);
  assert.equal(r.historyRecorded, 1);
  assert.equal(r.historyError, null);
  const rows = await prisma.priceHistory.findMany({ where: { shop: SHOP, sku: "H1" } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].priceCents, 1100);
  assert.equal(rows[0].rule, "NET");
  assert.equal(rows[0].source, "publisher");
  assert.equal(rows[0].at.toISOString(), "2026-10-12T10:00:00.000Z");
});
await check("sem rule explícita grava a regra global (LEGACY com a flag desligada)", async () => {
  await q.recordLastPriceWrites([{ sku: "H1", write: write(14.5, { at: "2026-10-01T10:00:00Z" }) }], { shop: SHOP });
  const rows = await prisma.priceHistory.findMany({ where: { shop: SHOP, sku: "H1", priceCents: 1450 } });
  assert.equal(rows[0].rule, "LEGACY");
});
await check("o backfill não entra no histórico (não é uma escrita datada)", async () => {
  const r = await q.recordLastPriceWrites([{ sku: "H1", write: write(9.99, { source: "backfill" }) }], { shop: SHOP });
  assert.equal(r.historyRecorded, 0);
  assert.equal(await prisma.priceHistory.count({ where: { shop: SHOP, priceCents: 999 } }), 0);
});
await check("SKU fora da fila: a última escrita vem em missing mas o preço enviado fica no histórico", async () => {
  const r = await q.recordLastPriceWrites([{ sku: "FORA", write: write(12) }], { shop: SHOP });
  assert.deepEqual(r.missing, ["FORA"]);
  assert.equal(r.historyRecorded, 1);
});
await check("falha do histórico não desfaz a última escrita: historyError", async () => {
  const origError = console.error;
  console.error = () => {};
  try {
    const r = await q.recordLastPriceWrites([{ sku: "H1", write: write(13) }], {
      shop: SHOP,
      recordHistory: async () => {
        throw new Error("tabela PriceHistory em falta");
      },
    });
    assert.deepEqual(r.recorded, ["H1"]);
    assert.equal(r.historyRecorded, 0);
    assert.match(r.historyError, /PriceHistory em falta/);
    assert.equal((await q.getCurationQueueEntry("H1")).metadata.lastPriceWrite.price, 13);
  } finally {
    console.error = origError;
  }
});
await check("sem loja resolvida o histórico falha à vista, não em silêncio", async () => {
  const prev = process.env.SHOPIFY_SHOP_URL;
  delete process.env.SHOPIFY_SHOP_URL;
  delete process.env.SHOPIFY_STORE;
  delete process.env.SHOPIFY_SHOP;
  const origError = console.error;
  console.error = () => {};
  try {
    const r = await q.recordLastPriceWrites([{ sku: "H1", write: write(13.5) }]);
    assert.match(r.historyError, /loja não resolvida/);
  } finally {
    console.error = origError;
    if (prev !== undefined) process.env.SHOPIFY_SHOP_URL = prev;
  }
});

console.log("getOmnibusMinBySkus");
await check("lê da BD só a regra pedida", async () => {
  await prisma.priceHistory.deleteMany({});
  await prisma.priceHistory.createMany({
    data: [
      { shop: SHOP, sku: "O1", priceCents: 900, rule: "NET", source: "reprice", at: ago(90) },
      { shop: SHOP, sku: "O1", priceCents: 1500, rule: "NET", source: "reprice", at: ago(5) },
      { shop: SHOP, sku: "O1", priceCents: 700, rule: "LEGACY", source: "publisher", at: ago(10) },
      { shop: SHOP, sku: "O2", priceCents: 1450, rule: "LEGACY", source: "publisher", at: ago(40) },
      { shop: "outra.myshopify.com", sku: "O1", priceCents: 100, rule: "NET", source: "publisher", at: ago(1) },
    ],
  });
  const net = await hist.getOmnibusMinBySkus(SHOP, ["O1", "O2", "O3"], { rule: "NET", now: NOW });
  assert.equal(net.get("O1"), 900);
  assert.equal(net.has("O2"), false);
  assert.equal(net.has("O3"), false);
  const legacy = await hist.getOmnibusMinBySkus(SHOP, ["O1", "O2"], { rule: "LEGACY", now: NOW });
  assert.equal(legacy.get("O1"), 700);
  assert.equal(legacy.get("O2"), 1450);
  // Sem rule explícita: a regra global (LEGACY com a flag desligada).
  const dflt = await hist.getOmnibusMinBySkus(SHOP, ["O1"], { now: NOW });
  assert.equal(dflt.get("O1"), 700);
});

await prisma.$disconnect();
if (failures) {
  console.error(`\n${failures} teste(s) falharam.`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
