#!/usr/bin/env node
/* eslint-env node */
/**
 * Lote 1 (Decisão 34), DBG-03, DBG-11 e DBG-22, contra a fila real em ficheiros temporários:
 *   - approveProduct e bulkSetQueueStatus recusam PUBLISHED → APPROVED, sem gravar nada;
 *   - PUBLISHED → PENDING continua permitido (é o que os scripts de revert usam);
 *   - o undo (restoreQueueSnapshots) não devolve um PUBLISHED a APPROVED;
 *   - o motor de publicação recusa SKUs fora de APPROVED antes de tocar na Shopify e falha o job;
 *   - fila corrompida e não recuperável: backup, flag DB_DEGRADED, leitura recusada e o ficheiro
 *     original fica intacto. Nunca reinício com fila vazia. O painel recebe a causa em `blocked`;
 *   - fila corrompida mas recuperável por sanitização: recupera, sem flag.
 * Uso: node scripts/tests/curation-queue-guards.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "queue-guards-"));
process.env.CURATION_DATA_DIR = tmp;
process.env.DATABASE_URL = `file:${path.join(tmp, "dev.sqlite")}`;
// O upsert lê config/ e server/data/ relativos ao cwd: ligo-os ao repo dentro do diretório temporário.
fs.symlinkSync(path.join(ROOT, "config"), path.join(tmp, "config"));
fs.mkdirSync(path.join(tmp, "server", "data"), { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, "server", "data"))) {
  if (f === "curation-queue.json") continue;
  fs.copyFileSync(path.join(ROOT, "server", "data", f), path.join(tmp, "server", "data", f));
}
process.chdir(tmp);

const q = await import(path.join(ROOT, "lib/curation/curationQueue.server.js"));
const { DbDegradedError, dbDegradedFlagPath } = await import(path.join(ROOT, "lib/health/dbDegraded.js"));
const engine = await import(path.join(ROOT, "lib/importer/shopify/shopifyApprovedSync.server.js"));
const reset = await import(path.join(ROOT, "lib/importer/shopify/shopifyReset.server.js"));
const { readShopifySyncStatus } = await import(path.join(ROOT, "lib/importer/shopify/shopifySyncJob.server.js"));

const QUEUE = path.join(tmp, "curation-queue.json");
const FLAG = dbDegradedFlagPath();
const SHOP = "queue-guards.myshopify.com";

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
  { sku: "PUB1", status: "PUBLISHED", shopifyProductId: "gid://shopify/Product/1", metadata: {} },
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

await check("approveProduct com a flag ativa e fila saudável é recusado, e o ficheiro fica como estava", async () => {
  writeQueue([{ sku: "P3", status: "PENDING", metadata: {} }]);
  fs.writeFileSync(FLAG, JSON.stringify({ cause: "teste de escrita", at: new Date().toISOString() }), "utf8");
  q.invalidateCurationMemoryCache();
  await assert.rejects(q.approveProduct("P3"), (e) => e.code === "DB_DEGRADED");
  assert.equal(JSON.parse(fs.readFileSync(QUEUE, "utf8")).items[0].status, "PENDING");
  clearFlag();
});

console.log("DBG-11 — o undo não devolve PUBLISHED a APPROVED");
await check("restoreQueueSnapshots com APPROVED sobre PUBLISHED é ignorado e reportado", async () => {
  writeQueue([{ sku: "PUB2", status: "PUBLISHED", shopifyProductId: "gid://shopify/Product/2", metadata: {} }]);
  const r = await q.restoreQueueSnapshots([{ sku: "PUB2", status: "APPROVED", metadata: {} }]);
  assert.deepEqual(r.skipped, ["PUB2"]);
  const item = (await q.loadCurationQueue()).items.find((i) => i.sku === "PUB2");
  assert.equal(item.status, "PUBLISHED");
  assert.equal(item.shopifyProductId, "gid://shopify/Product/2");
});

console.log("DBG-04, decisão 3 — o undo ignora itens com shopifyProductId e reporta-os");
await check("PUBLISHED com shopifyProductId e snapshot PENDING: o undo não o altera e reporta-o como ignorado", async () => {
  writeQueue([
    { sku: "PUB3", status: "PUBLISHED", shopifyStatus: "ACTIVE", metadata: { shopifyProductId: "gid://shopify/Product/3", publishedAt: "2026-10-10T00:00:00.000Z" } },
  ]);
  const r = await q.restoreQueueSnapshots([{ sku: "PUB3", status: "PENDING", shopifyStatus: "DRAFT", metadata: {} }]);
  assert.deepEqual(r.skipped, ["PUB3"]);
  assert.equal(r.skippedCount, 1);
  assert.equal(r.restored.length, 0);
  const item = (await q.loadCurationQueue()).items.find((i) => i.sku === "PUB3");
  assert.equal(item.status, "PUBLISHED");
  assert.equal(item.metadata.shopifyProductId, "gid://shopify/Product/3");
});

await check("controlo: um APPROVED sem shopifyProductId é restaurado e não é reportado como ignorado", async () => {
  writeQueue([
    { sku: "PUB3b", status: "PUBLISHED", shopifyStatus: "ACTIVE", metadata: { shopifyProductId: "gid://shopify/Product/31" } },
    { sku: "NP3", status: "APPROVED", shopifyStatus: "ACTIVE", metadata: { origem: "humano" } },
  ]);
  const r = await q.restoreQueueSnapshots([
    { sku: "PUB3b", status: "PENDING", shopifyStatus: "DRAFT", metadata: {} },
    { sku: "NP3", status: "PENDING", shopifyStatus: "DRAFT", metadata: {} },
  ]);
  assert.deepEqual(r.skipped, ["PUB3b"]);
  assert.equal(r.skippedCount, 1);
  assert.deepEqual(r.restored.map((i) => i.sku), ["NP3"]);
  assert.equal(await statusOf("NP3"), "PENDING");
  assert.equal(await statusOf("PUB3b"), "PUBLISHED");
});

await check("a resposta da rota e a mensagem do painel mostram os ignorados (contagem e SKU)", () => {
  const rota = fs.readFileSync(path.join(ROOT, "app/routes/api.curation.queue.undo.jsx"), "utf8");
  const painel = fs.readFileSync(path.join(ROOT, "app/routes/app._index.jsx"), "utf8");
  assert.match(rota, /skippedCount: result\.skippedCount/);
  assert.match(rota, /skipped: result\.skipped\.slice\(0, 50\)/);
  assert.match(painel, /data\.skippedCount/);
  assert.match(painel, /ignorado\(s\), já publicado\(s\) na Shopify/);
});

console.log("DBG-03 — o motor recusa SKUs fora de APPROVED antes da Shopify");
await check("runApprovedShopifySync com SKU PENDING: ok false, rejected, job falha, Shopify não chamada", async () => {
  clearFlag();
  writeQueue([
    { sku: "A1", status: "APPROVED", metadata: {} },
    { sku: "P9", status: "PENDING", metadata: {} },
  ]);
  const res = await engine.runApprovedShopifySync({ shop: SHOP }, { skus: ["A1", "P9"] });
  assert.equal(res.ok, false);
  assert.deepEqual(res.rejected, [{ sku: "P9", status: "PENDING" }]);
  const status = await readShopifySyncStatus(SHOP);
  assert.equal(status.state, "failed", "o job não pode ficar em running");
});

console.log("Lote 1, revisão — reindex e reset não devolvem PUBLISHED a APPROVED");
await check("upsert de importação não mexe num PUBLISHED, e o vínculo à Shopify fica", async () => {
  clearFlag();
  writeQueue([
    { sku: "UP1", status: "PUBLISHED", reason: "x", shopifyStatus: "ACTIVE", metadata: { smartRule: true, shopifyProductId: "gid://shopify/Product/77" } },
  ]);
  await q.upsertCurationQueueFromRecord({ sku: "UP1", title: "Título", _source: { title: "Título" }, netPrice: 10, grossPrice: 12, availableQuantity: 3, vendor: "V", categoryMain: "C" });
  const item = (await q.loadCurationQueue()).items.find((i) => i.sku === "UP1");
  assert.equal(item.status, "PUBLISHED");
  assert.equal(item.metadata.shopifyProductId, "gid://shopify/Product/77");
});

await check("reset: sweep põe PENDING retido; apagamento falhado fica pelo id, nunca pelo SKU de um item com id (DBG-30, 2.8 (7))", async () => {
  clearFlag();
  writeQueue([
    { sku: "D1", status: "PUBLISHED", metadata: { shopifyProductId: "gid://shopify/Product/10" } },
    { sku: "F1", status: "PUBLISHED", metadata: { shopifyProductId: "gid://shopify/Product/11" } },
    { sku: "X9", status: "PUBLISHED", metadata: { shopifyProductId: "gid://shopify/Product/9" } },
    { sku: "F2", status: "PUBLISHED", metadata: {} },
  ]);
  const n = await reset.revertAllPublishedInQueue({
    deletedInAdmin: true,
    exceptSkus: ["F1", "F2"],
    exceptIds: ["gid://shopify/Product/9"],
  });
  assert.equal(n, 2, "D1 e F1 revertem: F1 tem id e a exceção por SKU não o protege; X9 fica pelo id; F2 fica pelo SKU por não ter id");
  const items = (await q.loadCurationQueue()).items;
  const d1 = items.find((i) => i.sku === "D1");
  assert.equal(d1.status, "PENDING");
  assert.ok(d1.metadata.deletedInAdmin, "tem de ficar com a marca de apagado no admin");
  assert.equal(d1.metadata.shopifyProductId, undefined);
  assert.equal(items.find((i) => i.sku === "F1").status, "PENDING", "com id, o id decide: F1 não está na exceção de ids");
  assert.equal(items.find((i) => i.sku === "X9").status, "PUBLISHED");
  assert.equal(items.find((i) => i.sku === "F2").status, "PUBLISHED");
});

await check("reset: SYNC_ERROR fica como está, com ou sem id (D44, D11): nunca volta a PENDING", async () => {
  clearFlag();
  writeQueue([{ sku: "E1", status: "SYNC_ERROR", metadata: { syncError: "x" } }]);
  const n = await reset.revertAllPublishedInQueue({ deletedInAdmin: true });
  assert.equal(n, 0, "SYNC_ERROR não conta como revertido");
  const item = (await q.loadCurationQueue()).items.find((i) => i.sku === "E1");
  assert.equal(item.status, "SYNC_ERROR", "o reset não põe SYNC_ERROR em PENDING");
  assert.equal(item.metadata.syncError, "x", "o erro de sincronização fica");
});

await check("reset: produto apagado com sucesso volta a PENDING retido, nunca a APPROVED", async () => {
  clearFlag();
  writeQueue([{ sku: "D2", status: "PUBLISHED", metadata: { shopifyProductId: "gid://shopify/Product/20" } }]);
  const n = await reset.revertLocalAfterShopifyReset(["D2"], ["gid://shopify/Product/20"]);
  assert.equal(n, 1);
  const item = (await q.loadCurationQueue()).items.find((i) => i.sku === "D2");
  assert.equal(item.status, "PENDING");
  assert.equal(item.metadata.deletedInAdmin.previousShopifyProductId, "gid://shopify/Product/20");
});

await check("reset: SKU repetido noutra loja não arrasta um item ligado a outro id", async () => {
  clearFlag();
  writeQueue([{ sku: "S-1", status: "PUBLISHED", metadata: { shopifyProductId: "gid://shopify/Product/30" } }]);
  const n = await reset.revertLocalAfterShopifyReset(["S-1"], ["gid://shopify/Product/31"]);
  assert.equal(n, 0);
  const item = (await q.loadCurationQueue()).items.find((i) => i.sku === "S-1");
  assert.equal(item.status, "PUBLISHED");
  assert.equal(item.metadata.shopifyProductId, "gid://shopify/Product/30");
});

await check("fila em falta sem backup e sem catálogo: primeiro arranque, vazia, sem flag", async () => {
  clearFlag();
  fs.rmSync(QUEUE, { force: true });
  q.setCatalogCountReaderForTests(async () => 0);
  q.invalidateCurationMemoryCache();
  const queue = await q.loadCurationQueue();
  assert.deepEqual(queue.items, []);
  assert.equal(fs.existsSync(FLAG), false);
});

await check("fila em falta com backup de corrupção no volume: flag e leitura recusada", async () => {
  clearFlag();
  fs.rmSync(QUEUE, { force: true });
  const backup = path.join(tmp, "curation-queue.json.corrupt-2026-10-01T00-00-00-000Z.json");
  fs.writeFileSync(backup, "{x", "utf8");
  q.setCatalogCountReaderForTests(async () => 0);
  q.invalidateCurationMemoryCache();
  try {
    await assert.rejects(q.loadCurationQueue(), (e) => e.code === "DB_DEGRADED");
    assert.match(JSON.parse(fs.readFileSync(FLAG, "utf8")).cause, /backup de corrupção/);
  } finally {
    fs.rmSync(backup, { force: true });
  }
});

await check("fila em falta com produtos no catálogo (um só basta): flag e leitura recusada", async () => {
  clearFlag();
  fs.rmSync(QUEUE, { force: true });
  q.setCatalogCountReaderForTests(async () => 1);
  q.invalidateCurationMemoryCache();
  await assert.rejects(q.loadCurationQueue(), (e) => e.code === "DB_DEGRADED");
  assert.match(JSON.parse(fs.readFileSync(FLAG, "utf8")).cause, /catálogo populado \(1 produto\(s\)\)/);
});

await check("fila em falta e catálogo ilegível: recusa sem gravar a flag", async () => {
  clearFlag();
  fs.rmSync(QUEUE, { force: true });
  q.setCatalogCountReaderForTests(async () => {
    throw new Error("tabela ausente");
  });
  q.invalidateCurationMemoryCache();
  try {
    await assert.rejects(q.loadCurationQueue(), (e) => !(e instanceof DbDegradedError) && /não foi possível confirmar/.test(e.message));
    assert.equal(fs.existsSync(FLAG), false);
  } finally {
    q.setCatalogCountReaderForTests(async () => 0);
  }
});

await check("fila em falta que aparece durante a leitura: recusa, sem fila vazia nem flag, e o ficheiro fica", async () => {
  clearFlag();
  fs.rmSync(QUEUE, { force: true });
  q.setCatalogCountReaderForTests(async () => {
    fs.writeFileSync(QUEUE, JSON.stringify({ version: 1, updatedAt: null, items: [{ sku: "LATE1", status: "PENDING", metadata: {} }] }), "utf8");
    return 0;
  });
  q.invalidateCurationMemoryCache();
  try {
    await assert.rejects(q.loadCurationQueue(), (e) => /apareceu durante a leitura/.test(e.message));
    assert.equal(fs.existsSync(FLAG), false);
    assert.equal(JSON.parse(fs.readFileSync(QUEUE, "utf8")).items[0].sku, "LATE1");
  } finally {
    q.setCatalogCountReaderForTests(async () => 0);
  }
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

await check("loadCurationQueueForPanel com a fila degradada: fila vazia e causa em blocked", async () => {
  const r = await q.loadCurationQueueForPanel();
  assert.deepEqual(r.queue.items, []);
  assert.match(r.blocked, /fila de curadoria corrompida/);
});

await check("loadCurationQueueForPanel com a fila saudável: itens e blocked null", async () => {
  clearFlag();
  writeQueue([{ sku: "OK1", status: "PENDING", metadata: {} }]);
  const r = await q.loadCurationQueueForPanel();
  assert.equal(r.blocked, null);
  assert.equal(r.queue.items[0].sku, "OK1");
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
