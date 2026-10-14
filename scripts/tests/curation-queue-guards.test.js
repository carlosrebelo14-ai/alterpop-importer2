#!/usr/bin/env node
/* eslint-env node */
/**
 * Lote 1 (Decisão 34), DBG-11 e DBG-22, contra a fila real em ficheiros temporários:
 *   - approveProduct e bulkSetQueueStatus recusam PUBLISHED → APPROVED, sem gravar nada;
 *   - PUBLISHED → PENDING continua permitido (é o que os scripts de revert usam);
 *   - fila corrompida e não recuperável: backup, flag DB_DEGRADED, leitura recusada e o ficheiro
 *     original fica intacto. Nunca reinício com fila vazia;
 *   - fila corrompida mas recuperável por sanitização: recupera, sem flag.
 * Uso: node scripts/tests/curation-queue-guards.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "queue-guards-"));
process.env.CURATION_DATA_DIR = tmp;
process.env.DATABASE_URL = `file:${path.join(tmp, "dev.sqlite")}`;
const cwd = process.cwd();
process.chdir(tmp);

const q = await import(path.join(cwd, "lib/curation/curationQueue.server.js"));
const { DbDegradedError, dbDegradedFlagPath } = await import(path.join(cwd, "lib/health/dbDegraded.js"));

const QUEUE = path.join(tmp, "curation-queue.json");
const FLAG = dbDegradedFlagPath();

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

function writeQueue(items) {
  fs.writeFileSync(QUEUE, JSON.stringify({ version: 1, updatedAt: null, items }), "utf8");
  q.invalidateCurationMemoryCache();
}
function clearFlag() {
  fs.rmSync(FLAG, { force: true });
  q.invalidateCurationMemoryCache();
}
async function statusOf(sku) {
  return (await q.loadCurationQueue()).items.find((i) => i.sku === sku)?.status;
}

console.log("DBG-11 — PUBLISHED não volta a APPROVED");
clearFlag();
writeQueue([
  { sku: "PUB1", status: "PUBLISHED", metadata: {} },
  { sku: "P1", status: "PENDING", metadata: {} },
]);

await check("approveProduct recusa PUBLISHED e não grava", async () => {
  await assert.rejects(q.approveProduct("PUB1"), (e) => e.code === "APPROVE_PUBLISHED");
  assert.equal(await statusOf("PUB1"), "PUBLISHED");
});

await check("approveProduct continua a aprovar PENDING", async () => {
  await q.approveProduct("P1");
  assert.equal(await statusOf("P1"), "APPROVED");
});

writeQueue([
  { sku: "PUB1", status: "PUBLISHED", metadata: {} },
  { sku: "P2", status: "PENDING", metadata: {} },
]);

await check("bulkSetQueueStatus APPROVED com um PUBLISHED recusa o lote inteiro", async () => {
  await assert.rejects(
    q.bulkSetQueueStatus(["P2", "PUB1"], "APPROVED"),
    (e) => e.code === "APPROVE_PUBLISHED" && e.skus.join() === "PUB1"
  );
  assert.equal(await statusOf("P2"), "PENDING", "o lote não pode ter gravado a parte válida");
  assert.equal(await statusOf("PUB1"), "PUBLISHED");
});

await check("bulkSetQueueStatus PUBLISHED → PENDING continua permitido (revert)", async () => {
  await q.bulkSetQueueStatus(["PUB1"], "PENDING");
  assert.equal(await statusOf("PUB1"), "PENDING");
});

console.log("DBG-22 — fila corrompida não reinicia em silêncio");

await check("fila corrompida e não recuperável: backup, flag, leitura recusada, ficheiro intacto", async () => {
  clearFlag();
  const corrupt = "{ isto não é json";
  fs.writeFileSync(QUEUE, corrupt, "utf8");
  q.invalidateCurationMemoryCache();

  await assert.rejects(q.loadCurationQueue(), (e) => e instanceof DbDegradedError && e.code === "DB_DEGRADED");
  assert.ok(fs.existsSync(FLAG), "a flag DB_DEGRADED não foi gravada");
  assert.match(JSON.parse(fs.readFileSync(FLAG, "utf8")).cause, /fila de curadoria corrompida/);
  const backups = fs.readdirSync(tmp).filter((f) => /^curation-queue\.json\.corrupt-/.test(f));
  assert.equal(backups.length, 1, "tem de haver exatamente um backup");
  assert.equal(fs.readFileSync(QUEUE, "utf8"), corrupt, "o ficheiro original foi alterado");
});

await check("com a flag ativa, approveProduct é recusado com DB_DEGRADED", async () => {
  await assert.rejects(q.approveProduct("X"), (e) => e.code === "DB_DEGRADED");
  assert.equal(fs.readFileSync(QUEUE, "utf8"), "{ isto não é json");
});

await check("fila corrompida mas recuperável por sanitização: recupera, sem flag", async () => {
  clearFlag();
  const raw = '{"version":1,"items":[{"sku":"R1","status":"PENDING","metadata":{"note":"a\u0001b"}}]}';
  fs.writeFileSync(QUEUE, raw, "utf8");
  q.invalidateCurationMemoryCache();

  const queue = await q.loadCurationQueue();
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].sku, "R1");
  assert.equal(fs.existsSync(FLAG), false, "não devia ter gravado a flag");
});

fs.rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\ncuration-queue-guards: todos os casos passaram");
