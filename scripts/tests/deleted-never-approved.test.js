#!/usr/bin/env node
/**
 * Decisão do Carlos (09/10/2026): produto apagado no admin volta a PENDING com a nota
 * "apagado no admin" e a data, e a app nunca o recria sozinha. Falha se um item apagado
 * for parar a APPROVED, por qualquer caminho.
 * Uso: node scripts/tests/deleted-never-approved.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deleted-never-approved-"));
process.env.CURATION_DATA_DIR = tmp;
process.env.DATABASE_URL = `file:${path.join(tmp, "x.sqlite")}`;
const cwd = process.cwd();

const q = await import(path.join(cwd, "lib/curation/curationQueue.server.js"));
const { planDeletedMigration } = await import(path.join(cwd, "lib/curation/deletedMigration.js"));

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

const mk = (sku, status, metadata = {}) => ({ sku, title_en: sku, status, reason: "x", shopifyStatus: "ACTIVE", metadata });
await q.saveCurationQueue({
  version: 1,
  items: ["PENDING", "APPROVED", "REJECTED", "PUBLISHED", "SYNC_ERROR"].map((s) =>
    mk(s, s, { shopifyProductId: "gid://shopify/Product/9", lastPriceWrite: { price: 14.9 }, syncError: s === "SYNC_ERROR" ? "x" : null })
  ),
});

console.log("markQueueItemDeletedInAdmin");
for (const from of ["PENDING", "APPROVED", "REJECTED", "PUBLISHED", "SYNC_ERROR"]) {
  await check(`de ${from}: fica PENDING, nunca APPROVED, com nota e data`, async () => {
    const item = await q.markQueueItemDeletedInAdmin(from, { at: "2026-10-09T12:00:00.000Z" });
    assert.equal(item.status, "PENDING");
    assert.notEqual(item.status, "APPROVED");
    assert.equal(item.metadata.deletedInAdmin.note, "apagado no admin");
    assert.equal(item.metadata.deletedInAdmin.at, "2026-10-09T12:00:00.000Z");
    assert.equal(item.metadata.wasPublished, true);
    assert.equal(item.metadata.shopifyProductId, undefined);
    assert.equal(item.metadata.lastPriceWrite, undefined, "a última escrita deixa de descrever a loja");
    assert.equal(item.metadata.deletedInAdmin.lastPriceWrite.price, 14.9, "mas fica guardada");
    assert.equal(item.metadata.syncError, null);
  });
}
await check("SKU fora da fila devolve null, não cria nada", async () => {
  assert.equal(await q.markQueueItemDeletedInAdmin("NAO-EXISTE"), null);
  assert.equal(await q.getCurationQueueEntry("NAO-EXISTE"), null);
});

console.log("planDeletedMigration");
const items = new Map([
  ["REJ", mk("REJ", "REJECTED", { shopifyProductId: "gid://shopify/Product/1" })],
  ["REJ-NOID", mk("REJ-NOID", "REJECTED")],
  ["LIVE", mk("LIVE", "REJECTED")],
  ["APP", mk("APP", "APPROVED")],
  ["PUB", mk("PUB", "PUBLISHED")],
  ["PEND", mk("PEND", "PENDING")],
  ["EXISTS", mk("EXISTS", "REJECTED", { shopifyProductId: "gid://shopify/Product/2" })],
  ["UNREAD", mk("UNREAD", "REJECTED", { shopifyProductId: "gid://shopify/Product/3" })],
]);
const plan = planDeletedMigration({
  logSkus: [...items.keys(), "FORA", "REJ"],
  itemBySku: items,
  liveSkus: new Set(["LIVE"]),
  productExists: new Map([["REJ", false], ["EXISTS", true], ["UNREAD", null]]),
});
const by = Object.fromEntries(plan.map((r) => [r.sku, r]));
await check("migra REJECTED/SYNC_ERROR com prova de que o produto não existe", () => {
  assert.equal(by.REJ.action, "MIGRATE");
  assert.match(by.REJ.proof, /product\(id\) inexistente/);
  assert.equal(by["REJ-NOID"].action, "MIGRATE");
  assert.match(by["REJ-NOID"].proof, /sem id de produto guardado/);
});
await check("não toca em: com variante live, APPROVED, PUBLISHED, já PENDING, produto que existe, leitura falhada, fora da fila", () => {
  for (const sku of ["LIVE", "APP", "PUB", "PEND", "EXISTS", "UNREAD", "FORA"]) assert.equal(by[sku].action, "KEEP", sku);
  assert.match(by.APP.reason, /só toca em REJECTED/);
  assert.match(by.UNREAD.reason, /por provar/);
});
await check("SKU repetido no log conta uma vez", () => {
  assert.equal(plan.filter((r) => r.sku === "REJ").length, 1);
});

console.log("Scripts");
const read = (f) => fs.readFileSync(path.join(cwd, f), "utf8");
await check("curation-requeue-deleted.js recusa --to approved e não escreve APPROVED", () => {
  const src = read("scripts/catalog/curation-requeue-deleted.js");
  assert.match(src, /o único destino é PENDING/);
  assert.ok(!/status\s*=\s*TARGET|TARGET\s*===|"APPROVED"\s*\?/.test(src), "ainda há um destino configurável");
  assert.match(src, /markQueueItemDeletedInAdmin/);
});
await check("curation-mark-deleted.js só escreve pela função que devolve a PENDING", () => {
  const src = read("scripts/catalog/curation-mark-deleted.js");
  assert.match(src, /markQueueItemDeletedInAdmin/);
  assert.ok(!/status\s*=\s*["']APPROVED/.test(src));
  assert.ok(!/saveCurationQueue/.test(src), "escreve na fila por conta própria");
});
await check("publishedReprice.server.js: 'não encontrado' só passa por markQueueItemDeletedInAdmin", () => {
  const src = read("lib/importer/shopify/publishedReprice.server.js");
  assert.match(src, /markQueueItemDeletedInAdmin/);
  assert.ok(!/status\s*=\s*["']APPROVED/.test(src));
});

fs.rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
