import fs from "fs/promises";
import path from "path";
import "../../../lib/server/heartbeat.server.js";
import { prisma, safePrisma } from "../../prisma/prismaSafe.server.js";
import { getDefaultConfig } from "../config.js";
import { runImport } from "./runImport.js";
import { updateBackgroundImportProgress } from "./backgroundQueue.server.js";
import { logExecution } from "../logging/executionHistory.js";

let workerStarted = false;
let workerBusy = false;

export function ensureBackgroundWorkerStarted() {
  if (workerStarted) return;
  workerStarted = true;
  console.log("[background-worker] Fila de importação activa (SQLite/Prisma)");
  setInterval(() => {
    processNextQueuedJob().catch((err) => {
      console.error("[background-worker]", err?.message || err);
    });
  }, 1500);
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

    const summary = await runImport({
      session: payload.session,
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
