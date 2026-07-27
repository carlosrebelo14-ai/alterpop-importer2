import fs from "fs/promises";
import path from "path";
import { prisma, safePrisma } from "../../prisma/prismaSafe.server.js";
import { getDefaultConfig } from "../config.js";
import { logExecution } from "../logging/executionHistory.js";

function formatJobId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function statusPath(resultsJobId) {
  return path.join(getDefaultConfig().paths.results, resultsJobId, "status.json");
}

/**
 * Enfileira importação — retorna imediatamente (UI faz polling).
 * @param {{
 *   shop: string,
 *   session: { shop: string, accessToken: string },
 *   settings: object,
 *   dryRun?: boolean,
 *   filters?: object,
 *   productsOnly?: boolean,
 *   inventoryOnly?: boolean,
 *   loadTest?: boolean,
 * }} params
 */
export async function enqueueBackgroundImport({
  shop,
  session,
  settings,
  dryRun = false,
  filters = {},
  productsOnly = false,
  inventoryOnly = false,
  loadTest = false,
}) {
  const resultsJobId = formatJobId();
  const id = resultsJobId;
  const resultsDir = path.join(getDefaultConfig().paths.results, resultsJobId);
  await fs.mkdir(resultsDir, { recursive: true });

  const payload = JSON.stringify({
    settings,
    dryRun,
    filters,
    productsOnly,
    inventoryOnly,
    loadTest,
    session: { shop: session.shop, accessToken: session.accessToken },
  });

  await safePrisma("backgroundImportJob.create", () =>
    prisma.backgroundImportJob.create({
      data: {
        id,
        shop,
        state: "queued",
        progressPercent: 0,
        processedRows: 0,
        totalRows: settings.syncLimit || 0,
        dryRun,
        payload,
        resultsJobId,
      },
    })
  );

  await fs.writeFile(
    statusPath(resultsJobId),
    JSON.stringify(
      {
        jobId: resultsJobId,
        queueId: id,
        state: "queued",
        progressPercent: 0,
        processedRows: 0,
        totalRows: settings.syncLimit || 0,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
        summary: null,
      },
      null,
      2
    )
  );

  await logExecution({
    sku: "(job)",
    action: "atualizado",
    reason: dryRun ? "job_queued_dry_run" : "job_queued_live",
    jobId: resultsJobId,
  });

  const { ensureBackgroundWorkerStarted } = await import("./backgroundWorker.server.js");
  ensureBackgroundWorkerStarted();

  return { jobId: resultsJobId, queueId: id, state: "queued" };
}

/**
 * @param {string} jobId
 */
export async function getBackgroundImportStatus(jobId) {
  const row = await safePrisma("backgroundImportJob.findUnique", () =>
    prisma.backgroundImportJob.findUnique({ where: { id: jobId } }),
    { rethrow: false, fallback: null }
  );
  if (!row) {
    try {
      const fileStatus = JSON.parse(await fs.readFile(statusPath(jobId), "utf8"));
      return { ok: true, ...fileStatus, progressPercent: fileStatus.progressPercent ?? 0 };
    } catch {
      return null;
    }
  }

  let summary = null;
  if (row.state === "completed" || row.state === "failed") {
    try {
      summary = JSON.parse(
        await fs.readFile(
          path.join(getDefaultConfig().paths.results, row.resultsJobId, "summary.json"),
          "utf8"
        )
      );
    } catch {
      /* optional */
    }
  }

  return {
    ok: true,
    jobId: row.resultsJobId,
    queueId: row.id,
    shop: row.shop,
    state: row.state,
    progressPercent: Math.round(row.progressPercent * 10) / 10,
    processedRows: row.processedRows,
    totalRows: row.totalRows,
    currentSku: row.currentSku,
    dryRun: row.dryRun,
    error: row.error,
    startedAt: row.startedAt?.toISOString?.() ?? row.startedAt,
    finishedAt: row.finishedAt?.toISOString?.() ?? row.finishedAt,
    summary,
  };
}

/**
 * @param {string} id
 * @param {Partial<{ state: string, progressPercent: number, processedRows: number, totalRows: number, currentSku: string | null, error: string | null, startedAt: Date, finishedAt: Date }>} data
 */
export async function updateBackgroundImportProgress(id, data) {
  await safePrisma("backgroundImportJob.update", () =>
    prisma.backgroundImportJob.update({ where: { id }, data })
  );
  const row = await safePrisma("backgroundImportJob.findUnique", () =>
    prisma.backgroundImportJob.findUnique({ where: { id } }),
    { rethrow: false, fallback: null }
  );
  if (!row) return;

  let fileStatus = {};
  try {
    fileStatus = JSON.parse(await fs.readFile(statusPath(row.resultsJobId), "utf8"));
  } catch {
    fileStatus = { jobId: row.resultsJobId, queueId: id };
  }

  Object.assign(fileStatus, {
    state: data.state ?? row.state,
    progressPercent: data.progressPercent ?? row.progressPercent,
    processedRows: data.processedRows ?? row.processedRows,
    totalRows: data.totalRows ?? row.totalRows,
    currentSku: data.currentSku ?? row.currentSku,
    error: data.error ?? row.error,
    startedAt: (data.startedAt ?? row.startedAt)?.toISOString?.() ?? fileStatus.startedAt,
    finishedAt: (data.finishedAt ?? row.finishedAt)?.toISOString?.() ?? fileStatus.finishedAt,
  });

  await fs.writeFile(statusPath(row.resultsJobId), JSON.stringify(fileStatus, null, 2));
}

/**
 * @param {string} shop
 * @param {number} [limit]
 */
export async function listBackgroundJobsForShop(shop, limit = 10) {
  return safePrisma("backgroundImportJob.findMany", () =>
    prisma.backgroundImportJob.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    { fallback: [] }
  );
}
