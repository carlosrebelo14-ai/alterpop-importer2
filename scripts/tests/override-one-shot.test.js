#!/usr/bin/env node
/**
 * Revisão do PR #87 — override de preço da curadoria escrito uma só vez. O marcador
 * metadata.overridePriceApplied tem de sobreviver ao reindex (upsert da fila e flush do
 * snapshot em memória) e, nos itens publicados antes de existir, é deduzido de
 * overridesUpdatedAt ≤ publishedAt.
 * Corre sobre uma fila temporária (CURATION_DATA_DIR), nunca sobre a real.
 * Uso: node scripts/tests/override-one-shot.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "override-one-shot-"));
process.env.CURATION_DATA_DIR = tmp;

const q = await import("../../lib/curation/curationQueue.server.js");

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

const record = {
  sku: "SKU-1",
  title: "Test figure",
  vendor: "FUNKO",
  category: "Pop Culture",
  categoryMain: "Pop Culture",
  netPrice: 14.83,
  grossPrice: 17.95,
  distributorPrice: 9.99,
  availableQuantity: 5,
};

async function seed(item) {
  await q.saveCurationQueue({ version: 1, items: [item] });
}
async function entry() {
  return q.getCurationQueueEntry("SKU-1");
}

console.log("overridePriceAlreadyApplied");
await check("marcador gravado vence", () => {
  assert.equal(q.overridePriceAlreadyApplied({ overridePriceApplied: 25, overrides: { price: 30 } }), 25);
});
await check("sem marcador, override anterior à última publicação conta como escrito", () => {
  const md = { overrides: { price: 29.99 }, overridesUpdatedAt: "2026-09-13T00:00:00Z", publishedAt: "2026-09-16T11:08:07Z" };
  assert.equal(q.overridePriceAlreadyApplied(md), 29.99);
});
await check("sem marcador, override posterior à última publicação é novo", () => {
  const md = { overrides: { price: 29.99 }, overridesUpdatedAt: "2026-09-20T00:00:00Z", publishedAt: "2026-09-16T11:08:07Z" };
  assert.equal(q.overridePriceAlreadyApplied(md), null);
});
await check("nunca publicado → nada escrito", () => {
  assert.equal(q.overridePriceAlreadyApplied({ overrides: { price: 29.99 }, overridesUpdatedAt: "2026-09-20T00:00:00Z" }), null);
});

console.log("Marcador sobrevive à fila");
await check("recordOverridePriceApplied grava o marcador", async () => {
  await seed({ sku: "SKU-1", title_en: "x", status: "PUBLISHED", reason: "approved", shopifyStatus: "ACTIVE", metadata: { overrides: { price: 25 } } });
  await q.recordOverridePriceApplied("SKU-1", 25);
  assert.equal((await entry()).metadata.overridePriceApplied, 25);
});
await check("reindex de item com smartRule (ramo não manual) mantém overrides e marcador", async () => {
  await seed({
    sku: "SKU-1",
    title_en: "x",
    status: "PUBLISHED",
    reason: "smart_auto_approve",
    shopifyStatus: "ACTIVE",
    metadata: { smartRule: true, overrides: { price: 25 }, overridesUpdatedAt: "2026-09-20T00:00:00Z", overridePriceApplied: 25 },
  });
  await q.upsertCurationQueueFromRecord({ ...record });
  const md = (await entry()).metadata;
  assert.equal(md.overrides?.price, 25);
  assert.equal(md.overridePriceApplied, 25);
});
await check("flush do snapshot do reindex não apaga um marcador gravado entretanto", async () => {
  await seed({ sku: "SKU-1", title_en: "x", status: "PUBLISHED", reason: "approved", shopifyStatus: "ACTIVE", metadata: { overrides: { price: 25 } } });
  const stale = structuredClone(await entry()); // cópia tirada no início do reindex
  await q.recordOverridePriceApplied("SKU-1", 25); // publish a meio do reindex
  await q.flushCurationQueueItems([stale]);
  assert.equal((await entry()).metadata.overridePriceApplied, 25);
});

fs.rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
