import "../../../lib/server/heartbeat.server.js";
import { prisma, safePrisma } from "../../prisma/prismaSafe.server.js";
import { runImport } from "./runImport.js";
import { updateBackgroundImportProgress } from "./backgroundQueue.server.js";
import { logExecution } from "../logging/executionHistory.js";
import { loadOfflineSessionForShop } from "../../session/loadOfflineSessionForShop.server.js";

let workerStarted = false;
let workerBusy = false;

export function ensureBackgroundWorkerStarted() {
  if (workerStarted) return;
  workerStarted = true;
  console.log("[background-worker] Fila de importação activa (SQLite/Prisma)");
  recoverOrphanedJobs().catch((err) => {
    console.error("[background-worker] recuperação de jobs órfãos falhou:", err?.message || err);
  });
  setInterval(() => {
    processNextQueuedJob().catch((err) => {
      console.error("[background-worker]", err?.message || err);
    });
  }, 1500);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fix (code review 2026-08-13) — se o processo reiniciar (ex.: fly deploy) enquanto
 * um job está state="running", ficava preso nesse estado para sempre: o worker só
 * apanha jobs "queued". Corrido uma vez no arranque, marca qualquer job "running"
 * órfão como falhado (nunca assume que terminou com sucesso — não há forma de saber).
 *
 * Auditoria 2026-09-22 — isto só corre UMA vez por vida do processo (gate implícito
 * em ensureBackgroundWorkerStarted). Antes, uma falha transitória de leitura nesse
 * exato momento (ex.: SQLite ainda a terminar WAL recovery mesmo depois de um
 * restart, cenário para o qual esta app já configura busy_timeout) era tratada como
 * "sem jobs órfãos" (fallback:[]) e a recuperação nunca mais era tentada — o job
 * ficava "running" para sempre, invisível a qualquer recuperação automática.
 * Repete a leitura algumas vezes com atraso crescente antes de desistir, já que a
 * falha que motivou o fix original é inerentemente transitória.
 */
async function recoverOrphanedJobs() {
  const RETRY_DELAYS_MS = [1000, 3000, 5000];
  let orphaned = null;

  for (let attempt = 0; ; attempt++) {
    try {
      orphaned = await prisma.backgroundImportJob.findMany({ where: { state: "running" } });
      break;
    } catch (err) {
      console.error(
        `[background-worker] recuperação de jobs órfãos: tentativa ${attempt + 1} falhou (${err?.message || err})`
      );
      if (attempt >= RETRY_DELAYS_MS.length) {
        console.error(
          "[background-worker] recuperação de jobs órfãos ABORTADA após esgotar tentativas — " +
            "jobs presos em \"running\" de uma sessão anterior podem não ter sido detetados."
        );
        return;
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  for (const job of orphaned) {
    console.warn(`[background-worker] job órfão ${job.id} (estava "running") — marcado como falhado.`);
    await updateBackgroundImportProgress(job.id, {
      state: "failed",
      finishedAt: new Date(),
      error: "Processo reiniciado a meio do job (ex.: deploy) — estado não recuperável.",
      currentSku: null,
    });
  }
}

export async function processNextQueuedJob() {
  if (workerBusy) return;
  // workerBusy tem de ficar marcado ANTES do primeiro await (bug encontrado em
  // auditoria, 2026-09-22) — estava a ser marcado só depois do findFirst(). O
  // setInterval chama esta função a cada 1500ms; se o findFirst demorar mais do que
  // isso (plausível: busy_timeout do SQLite é 5000ms, partilhado com o worker de
  // reindexação e o servidor HTTP — ver configureSqlite.server.js), duas execuções
  // sobrepostas passavam ambas pelo `if (workerBusy) return;` com o mesmo valor
  // "false" e podiam apanhar e arrancar o MESMO job em paralelo.
  workerBusy = true;

  try {
    const next = await safePrisma("backgroundImportJob.findFirst", () =>
      prisma.backgroundImportJob.findFirst({
        where: { state: "queued" },
        orderBy: { createdAt: "asc" },
      }),
      { rethrow: false, fallback: null }
    );

    if (!next) return;

    const startedAt = new Date();

    try {
      await updateBackgroundImportProgress(next.id, {
        state: "running",
        startedAt,
        progressPercent: 0,
      });

      const payload = JSON.parse(next.payload);
      const totalPlanned = payload.settings?.syncLimit || next.totalRows || 0;

      // Sessão carregada fresca (não persistida no payload — ver enqueueBackgroundImport).
      const session = await loadOfflineSessionForShop(payload.session.shop);

      const summary = await runImport({
        session,
        settings: payload.settings,
        dryRun: payload.dryRun,
        filters: payload.filters,
        productsOnly: payload.productsOnly,
        inventoryOnly: payload.inventoryOnly,
        loadTest: payload.loadTest,
        jobIdOverride: next.resultsJobId,
        onProgress: async ({ processed, total, currentSku }) => {
          const totalRows = total || totalPlanned || processed;
          const percent = totalRows > 0 ? Math.min(100, (processed / totalRows) * 100) : 0;
          await updateBackgroundImportProgress(next.id, {
            state: "running",
            processedRows: processed,
            totalRows,
            currentSku: currentSku || null,
            progressPercent: percent,
          });
        },
      });

      await updateBackgroundImportProgress(next.id, {
        state: "completed",
        finishedAt: new Date(),
        progressPercent: 100,
        processedRows: summary.metrics?.totalRows ?? next.processedRows,
        totalRows: summary.metrics?.totalRows ?? totalPlanned,
        currentSku: null,
      });

      await logExecution({
        sku: "(job)",
        action: "importado",
        reason: "job_completed",
        jobId: next.resultsJobId,
      });
    } catch (err) {
      const message = err?.message || String(err);
      await updateBackgroundImportProgress(next.id, {
        state: "failed",
        finishedAt: new Date(),
        error: message,
        currentSku: null,
      });

      await logExecution({
        sku: "(job)",
        action: "rejeitado",
        reason: `job_failed: ${message}`,
        jobId: next.resultsJobId,
      });

      console.error(`[background-worker] Job ${next.id} failed:`, message);
    }
  } finally {
    workerBusy = false;
  }
}
