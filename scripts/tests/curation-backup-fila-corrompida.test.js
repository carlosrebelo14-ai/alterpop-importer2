#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-85. Três leituras seguidas de uma fila corrompida, com o lock ocupado, produzem um só ficheiro de
 * backup. Antes, cada leitura que estourava o lock gravava um backup novo de cerca de 15 MB.
 *
 * Uso: node scripts/tests/curation-backup-fila-corrompida.test.js
 */
import "./_isolate-curation.js";

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATA_DIR = process.env.CURATION_DATA_DIR;
const QUEUE_PATH = path.join(DATA_DIR, "curation-queue.json");
const q = await import(pathToFileURL(path.join(REPO, "lib", "curation", "curationQueue.server.js")).href);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// O caráter de controlo faz o JSON falhar, e a sanitização recupera a fila: é o caminho que grava backup.
const BRUTO = '{"version":1,"updatedAt":null,"items":[{"sku":"SKU-D85\u0001","title_en":"Teste","status":"PENDING"}]}';

function backups() {
  return fs.readdirSync(DATA_DIR).filter((nome) => nome.startsWith("curation-queue.json.corrupt-"));
}

let falhas = 0;
async function check(nome, fn) {
  try {
    await fn();
    console.log(`  ok  ${nome}`);
  } catch (err) {
    falhas += 1;
    console.error(`FAIL  ${nome}\n      ${err.message}`);
  }
}

console.log("curation-backup-fila-corrompida");
process.env.CURATION_QUEUE_LOCK_PRAZO_ROTA_MS = "300";
fs.writeFileSync(QUEUE_PATH, BRUTO, "utf8");

await check("três leituras seguidas com o lock ocupado: estouram o lock e gravam um só backup", async () => {
  q.invalidateCurationMemoryCache();
  const detentor = q.comLockDaFila(() => sleep(1500));
  await sleep(50);
  const codigos = [];
  for (let i = 0; i < 3; i += 1) {
    q.invalidateCurationMemoryCache();
    const erro = await q.comPrazoDeRota(() => q.loadCurationQueue()).then(
      () => null,
      (e) => e
    );
    codigos.push(erro?.code ?? "sem erro");
  }
  await detentor;
  assert.deepEqual(codigos, ["CURATION_QUEUE_LOCK_TIMEOUT", "CURATION_QUEUE_LOCK_TIMEOUT", "CURATION_QUEUE_LOCK_TIMEOUT"]);
  assert.equal(backups().length, 1, `três leituras seguidas gravaram ${backups().length} backups`);
  assert.equal(fs.readFileSync(path.join(DATA_DIR, backups()[0]), "utf8"), BRUTO, "o backup tem o conteúdo original");
});

await check("com o lock libertado, a leitura recupera a fila e não grava outro backup", async () => {
  q.invalidateCurationMemoryCache();
  const fila = await q.loadCurationQueue();
  assert.equal(fila.items.length, 1, "a fila tem de ser recuperada");
  assert.equal(backups().length, 1, "a recuperação não pode gravar outro backup");
});

fs.rmSync(DATA_DIR, { recursive: true, force: true });
if (falhas) {
  console.error(`\ncuration-backup-fila-corrompida: ${falhas} verificação(ões) falharam`);
  process.exit(1);
}
console.log("\ncuration-backup-fila-corrompida: todos os casos passaram");
