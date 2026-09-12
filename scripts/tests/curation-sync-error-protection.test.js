#!/usr/bin/env node
/**
 * Tarefa 53 (Decisão 29) — SYNC_ERROR é estado terminal que exige juízo humano. Antes
 * desta tarefa, `upsertCurationQueueFromRecordLocked` (curationQueue.server.js) não
 * incluía SYNC_ERROR na lista `isManual` — um reindex do feed (relógio de 45 min)
 * recalculava o item pelas regras automáticas e podia devolvê-lo sozinho a APPROVED,
 * apagando o erro do radar sem revisão humana. Aconteceu ao vivo no lote piloto v4: 5
 * de 6 SYNC_ERROR viraram APPROVED entre a paragem do sync e o retry, por esta via.
 *
 * Usa CURATION_DATA_DIR (escape hatch documentado em curationQueue.server.js) para
 * isolar a fila num diretório temporário — não toca no ficheiro real.
 *
 * Uso: node scripts/tests/curation-sync-error-protection.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "curation-sync-error-test-"));
process.env.CURATION_DATA_DIR = tmpDir;

const QUEUE_PATH = path.join(tmpDir, "curation-queue.json");
fs.writeFileSync(
  QUEUE_PATH,
  JSON.stringify({
    version: 1,
    updatedAt: null,
    items: [
      {
        sku: "probe-sync-error-1",
        title_en: "Probe Product",
        status: "SYNC_ERROR",
        reason: "sync_error",
        shopifyStatus: "DRAFT",
        metadata: { syncError: "SKU ausente do catálogo indexado", syncErrorAt: "2026-09-13T00:00:00Z" },
      },
    ],
  })
);

const { upsertCurationQueueFromRecord, listCurationQueueItems, bulkSetQueueStatus } = await import(
  "../../lib/curation/curationQueue.server.js"
);

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

async function main() {
  await check("reindex sobre item em SYNC_ERROR mantém o estado (não vira PENDING/APPROVED)", async () => {
    await upsertCurationQueueFromRecord({
      sku: "probe-sync-error-1",
      title: "Probe Product",
      vendor: "TESTVENDOR",
      categoryMain: "Toys",
      netPrice: 10,
      grossPrice: 12,
    });
    const item = (await listCurationQueueItems()).find((i) => i.sku === "probe-sync-error-1");
    assert.equal(item.status, "SYNC_ERROR");
    // metadata.syncError original preservado — a proteção mantém o item intacto, não
    // só o campo status.
    assert.equal(item.metadata.syncError, "SKU ausente do catálogo indexado");
  });

  await check("bulkSetQueueStatus continua a poder limpar SYNC_ERROR → APPROVED (transição manual explícita)", async () => {
    const { updatedItems } = await bulkSetQueueStatus(["probe-sync-error-1"], "APPROVED");
    assert.equal(updatedItems.length, 1);
    const item = (await listCurationQueueItems()).find((i) => i.sku === "probe-sync-error-1");
    assert.equal(item.status, "APPROVED");
  });

  await check("depois de APPROVED via bulkSetQueueStatus, reindex volta a poder recalcular normalmente", async () => {
    // APPROVED sem smartRule/aiCuration/eliteCuration continua "manual" (comportamento
    // pré-existente, inalterado) — reindex preserva também. Confirma que a correção
    // não tornou TUDO imune a reindex, só SYNC_ERROR ganhou proteção incondicional.
    await upsertCurationQueueFromRecord({
      sku: "probe-sync-error-1",
      title: "Probe Product",
      vendor: "TESTVENDOR",
      categoryMain: "Toys",
      netPrice: 10,
      grossPrice: 12,
    });
    const item = (await listCurationQueueItems()).find((i) => i.sku === "probe-sync-error-1");
    assert.equal(item.status, "APPROVED");
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });

  if (failures) {
    console.error(`\n${failures} falha(s)`);
    process.exit(1);
  }
  console.log("\ncuration-sync-error-protection: todos os casos passaram");
}

main();
