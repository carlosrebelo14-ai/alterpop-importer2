import fs from "fs/promises";
import path from "path";
import "../../../lib/server/heartbeat.server.js";
import { prisma, safePrisma } from "../../prisma/prismaSafe.server.js";
import { getDefaultConfig } from "../config.js";
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

/**
 * Fix (code review 2026-08-13) — se o processo reiniciar (ex.: fly deploy) enquanto
 * um job está state="running", ficava preso nesse estado para sempre: o worker só
 * apanha jobs "queued". Corrido uma vez no arranque, marca qualquer job "running"
 * órfão como falhado (nunca assume que terminou com sucesso — não há forma de saber).
 */
async function recoverOrphanedJobs() {
  const orphaned = await safePrisma(
    "backgroundImportJob.findOrphaned",
    () => prisma.backgroundImportJob.findMany({ where: { state: "running" } }),
    { rethrow: false, fallback: [] }
  );
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

async function processNextQueuedJob() {
  if (workerBusy) return;

  const next = await safePrisma("backgroundImportJob.findFirst", () =>
    prisma.backgroundImportJob.findFirst({
      where: { state: "queued" },
      orderBy: { createdAt: "asc" },
    }),
    { rethrow: false, fallback: null }
  );

  if (!next) return;

  workerBusy = true;
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
  } finally {
    workerBusy = false;
  }
}
