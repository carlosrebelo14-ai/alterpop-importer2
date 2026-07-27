import fs from "fs/promises";
import path from "path";
import { getDefaultConfig } from "../config.js";
import {
  enqueueBackgroundImport,
  getBackgroundImportStatus,
} from "./backgroundQueue.server.js";
import { ensureBackgroundWorkerStarted } from "./backgroundWorker.server.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Inicia importação na fila persistente (Prisma/SQLite).
 * A UI não deve usar waitForCompletion — apenas polling em /api/import/status/:jobId.
 */
export async function startImportJob({
  session,
  settings,
  waitForCompletion = false,
  dryRun = false,
  filters = {},
  productsOnly = false,
  inventoryOnly = false,
  loadTest = false,
}) {
  ensureBackgroundWorkerStarted();

  const result = await enqueueBackgroundImport({
    shop: session.shop,
    session,
    settings,
    dryRun,
    filters,
    productsOnly,
    inventoryOnly,
    loadTest,
  });

  if (waitForCompletion) {
    while (true) {
      const status = await getBackgroundImportStatus(result.jobId);
      if (!status) return result;
      if (status.state === "completed" || status.state === "failed") {
        return status;
      }
      await sleep(500);
    }
  }

  return result;
}

export async function getJobStatus(jobId) {
  return getBackgroundImportStatus(jobId);
}

export async function listRecentJobs(limit = 20) {
  const resultsDir = getDefaultConfig().paths.results;
  let entries;
  try {
    entries = await fs.readdir(resultsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const jobs = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    try {
      const summaryRaw = await fs.readFile(
        path.join(resultsDir, ent.name, "summary.json"),
        "utf8"
      );
      jobs.push(JSON.parse(summaryRaw));
    } catch {
      try {
        const statusRaw = await fs.readFile(
          path.join(resultsDir, ent.name, "status.json"),
          "utf8"
        );
        jobs.push(JSON.parse(statusRaw));
      } catch {
        /* skip */
      }
    }
  }

  return jobs
    .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""))
    .slice(0, limit);
}
