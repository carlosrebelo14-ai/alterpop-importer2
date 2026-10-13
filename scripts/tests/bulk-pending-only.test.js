#!/usr/bin/env node
/* eslint-env node */
/**
 * Decisão 31 — aprovar/rejeitar em massa SÓ tocam produtos PENDING:
 *   - PUBLISHED, REJECTED, SYNC_ERROR e APPROVED ficam exatamente como estavam;
 *   - SKU sem entrada na fila conta como PENDING: cria a entrada e aplica a transição, numa
 *     só operação, e o resultado reporta à parte quantos foram criados;
 *   - idempotente: repetir a ação não cria duplicados nem muda o que já foi decidido;
 *   - o número a confirmar é o dos elegíveis; o undo apaga as entradas criadas.
 * Uso: node scripts/tests/bulk-pending-only.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bulk-pending-"));
process.env.CURATION_DATA_DIR = tmp;
process.env.DATABASE_URL = `file:${path.join(tmp, "x.sqlite")}`;
const cwd = process.cwd();
process.chdir(tmp);

const q = await import(path.join(cwd, "lib/curation/curationQueue.server.js"));
const { partitionBulkEligible } = await import(path.join(cwd, "lib/curation/bulkEligibility.js"));
const { assertBulkConfirm, BulkConfirmError } = await import(path.join(cwd, "lib/curation/bulkConfirm.js"));

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

const item = (sku, status, extra = {}) => ({
  sku,
  title_en: `Produto ${sku}`,
  status,
  reason: "seed",
  shopifyStatus: status === "PUBLISHED" ? "ACTIVE" : "DRAFT",
  metadata: { queuedAt: "2026-10-01T00:00:00.000Z", approvedAt: null, rejectedAt: null, ...extra },
});
const seed = () => [
  item("P1", "PENDING"),
  item("P2", "PENDING"),
  item("A1", "APPROVED", { approvedAt: "2026-10-02T00:00:00.000Z" }),
  item("R1", "REJECTED", { rejectedAt: "2026-10-02T00:00:00.000Z" }),
  item("PU1", "PUBLISHED", { shopifyProductId: "gid://shopify/Product/1" }),
  item("SE1", "SYNC_ERROR", { syncError: "boom" }),
];
const byStatus = async () => Object.fromEntries((await q.loadCurationQueue()).items.map((i) => [i.sku, i.status]));
const clone = (v) => JSON.parse(JSON.stringify(v));

console.log("partitionBulkEligible");
await check("PENDING e sem entrada são elegíveis; o resto é ignorado, com o estado", () => {
  const { eligible, toCreate, skipped } = partitionBulkEligible(seed(), ["P1", "NEW", "A1", "R1", "PU1", "SE1", "P1", " NEW ", ""]);
  assert.deepEqual(eligible, ["P1", "NEW"]);
  assert.deepEqual(toCreate, ["NEW"]);
  assert.deepEqual(skipped, [
    { sku: "A1", status: "APPROVED" },
    { sku: "R1", status: "REJECTED" },
    { sku: "PU1", status: "PUBLISHED" },
    { sku: "SE1", status: "SYNC_ERROR" },
  ]);
});
await check("o número a confirmar é o dos elegíveis, não o dos pedidos", () => {
  const items = [
    ...Array.from({ length: 60 }, (_, i) => item(`P${i}`, "PENDING")),
    ...Array.from({ length: 40 }, (_, i) => item(`U${i}`, "PUBLISHED")),
  ];
  const requested = items.map((i) => i.sku);
  const { eligible } = partitionBulkEligible(items, requested);
  assert.equal(requested.length, 100);
  assert.equal(eligible.length, 60);
  assert.throws(() => assertBulkConfirm(eligible.length, 100), (e) => e instanceof BulkConfirmError && e.code === "COUNT_MISMATCH" && e.count === 60);
  assert.doesNotThrow(() => assertBulkConfirm(eligible.length, 60));
});

console.log("bulkTransitionPending");
await check("aprova só PENDING e cria o que não tem entrada; o resto fica intocado", async () => {
  await q.saveCurationQueue({ version: 1, items: seed() });
  const before = clone((await q.loadCurationQueue()).items);
  const r = await q.bulkTransitionPending(["P1", "P2", "NEW1", "A1", "R1", "PU1", "SE1"], "APPROVED");
  assert.deepEqual(r.skus.sort(), ["NEW1", "P1", "P2"]);
  assert.equal(r.updatedItems.length, 3);
  assert.deepEqual(r.created, ["NEW1"]);
  assert.equal(r.createdCount, 1);
  assert.deepEqual(r.skipped.map((s) => s.sku).sort(), ["A1", "PU1", "R1", "SE1"]);
  const st = await byStatus();
  assert.equal(st.P1, "APPROVED");
  assert.equal(st.P2, "APPROVED");
  assert.equal(st.NEW1, "APPROVED");
  const after = (await q.loadCurationQueue()).items;
  for (const sku of ["A1", "R1", "PU1", "SE1"]) {
    assert.deepEqual(after.find((i) => i.sku === sku), before.find((i) => i.sku === sku), `${sku} foi alterado`);
  }
  const created = after.find((i) => i.sku === "NEW1");
  assert.equal(created.reason, "manual_dashboard_bulk");
  assert.equal(created.shopifyStatus, "ACTIVE");
  assert.ok(created.metadata.approvedAt);
});
await check("idempotente: repetir não cria duplicados nem altera nada", async () => {
  const before = clone((await q.loadCurationQueue()).items);
  const r = await q.bulkTransitionPending(["P1", "P2", "NEW1", "A1"], "APPROVED");
  assert.equal(r.updatedItems.length, 0);
  assert.equal(r.createdCount, 0);
  assert.deepEqual(r.skus, []);
  assert.deepEqual(r.skipped.map((s) => s.status), ["APPROVED", "APPROVED", "APPROVED", "APPROVED"]);
  const after = (await q.loadCurationQueue()).items;
  assert.equal(after.filter((i) => i.sku === "NEW1").length, 1);
  assert.deepEqual(after, before);
});
await check("rejeitar também só toca PENDING e cria o que falta como REJECTED", async () => {
  await q.saveCurationQueue({ version: 1, items: seed() });
  const r = await q.bulkTransitionPending(["P1", "NEW2", "A1", "PU1", "SE1", "R1"], "REJECTED");
  assert.deepEqual(r.skus.sort(), ["NEW2", "P1"]);
  assert.deepEqual(r.created, ["NEW2"]);
  const st = await byStatus();
  assert.equal(st.P1, "REJECTED");
  assert.equal(st.NEW2, "REJECTED");
  assert.equal(st.A1, "APPROVED");
  assert.equal(st.PU1, "PUBLISHED");
  assert.equal(st.SE1, "SYNC_ERROR");
  const created = (await q.loadCurationQueue()).items.find((i) => i.sku === "NEW2");
  assert.equal(created.shopifyStatus, "DRAFT");
  assert.ok(created.metadata.rejectedAt);
});
await check("sem elegíveis não escreve na fila", async () => {
  await q.saveCurationQueue({ version: 1, items: seed() });
  const file = fs.readdirSync(tmp).find((f) => f.endsWith(".json"));
  const mtime = fs.statSync(path.join(tmp, file)).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  const r = await q.bulkTransitionPending(["A1", "R1", "PU1", "SE1"], "APPROVED");
  assert.equal(r.updatedItems.length, 0);
  assert.equal(fs.statSync(path.join(tmp, file)).mtimeMs, mtime);
});
await check("estado alvo inválido lança", async () => {
  await assert.rejects(() => q.bulkTransitionPending(["P1"], "PUBLISHED"));
});

console.log("undo");
await check("o undo repõe os PENDING e apaga as entradas criadas pela ação", async () => {
  await q.saveCurationQueue({ version: 1, items: seed() });
  const r = await q.bulkTransitionPending(["P1", "NEW3", "A1"], "APPROVED");
  assert.ok(r.previousSnapshots.some((s) => s.sku === "NEW3" && s.created === true));
  const restored = await q.restoreQueueSnapshots(r.previousSnapshots);
  assert.equal(restored.restored.length, 2);
  const st = await byStatus();
  assert.equal(st.P1, "PENDING");
  assert.equal("NEW3" in st, false, "a entrada criada ficou");
  assert.equal(st.A1, "APPROVED");
});
await check("o undo não apaga uma entrada criada que entretanto foi publicada", async () => {
  await q.saveCurationQueue({ version: 1, items: seed() });
  const r = await q.bulkTransitionPending(["NEW4"], "APPROVED");
  await q.markQueueItemPublished("NEW4", "gid://shopify/Product/9");
  await q.restoreQueueSnapshots(r.previousSnapshots);
  assert.equal((await byStatus()).NEW4, "PUBLISHED");
});

console.log("rota");
await check("a rota só usa bulkTransitionPending e devolve os alterados, os criados e os ignorados", () => {
  const src = fs.readFileSync(path.join(cwd, "app/routes/api.curation.queue.bulk.jsx"), "utf8");
  assert.ok(!/bulkSetQueueStatus/.test(src));
  assert.match(src, /bulkTransitionPending\(eligible, targetStatus\)/);
  for (const key of ["createdCount", "skipped", "skus: result.skus", "previousSnapshots"]) assert.ok(src.includes(key), key);
});

if (failures) {
  console.error(`\n${failures} teste(s) falharam.`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
