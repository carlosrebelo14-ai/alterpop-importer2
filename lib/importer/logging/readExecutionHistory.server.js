import fs from "fs/promises";
import path from "path";
import { getDefaultConfig } from "../config.js";
import { LOG_PATH } from "./executionHistory.js";

/**
 * Agrega linhas do execution-history.log por jobId.
 * @param {{ limit?: number }} [opts]
 */
export async function listImportHistoryFromLog({ limit = 30 } = {}) {
  let raw = "";
  try {
    raw = await fs.readFile(LOG_PATH, "utf8");
  } catch {
    return [];
  }

  const jobs = new Map();

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 5) continue;

    const [timestamp, sku, action, reason, jobId] = parts;
    if (!jobId) continue;

    if (!jobs.has(jobId)) {
      jobs.set(jobId, {
        jobId,
        startedAt: timestamp,
        finishedAt: timestamp,
        skuCount: 0,
        imported: 0,
        updated: 0,
        rejected: 0,
        jobEvents: [],
      });
    }

    const row = jobs.get(jobId);
    row.finishedAt = timestamp;
    if (timestamp < row.startedAt) row.startedAt = timestamp;

    if (sku === "(job)") {
      row.jobEvents.push({ timestamp, action, reason });
      continue;
    }

    row.skuCount += 1;
    if (action === "importado") row.imported += 1;
    else if (action === "atualizado") row.updated += 1;
    else if (action === "rejeitado") row.rejected += 1;
  }

  const resultsDir = getDefaultConfig().paths.results;
  const enriched = [];

  for (const job of jobs.values()) {
    const completedEvent = job.jobEvents.find((e) => e.reason === "job_completed");
    const failedEvent = job.jobEvents.find((e) =>
      String(e.reason || "").startsWith("job_failed")
    );
    let hasSummary = false;
    try {
      await fs.access(path.join(resultsDir, job.jobId, "summary.json"));
      hasSummary = true;
    } catch {
      /* no summary yet */
    }

    enriched.push({
      jobId: job.jobId,
      date: job.finishedAt || job.startedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      skuCount: job.skuCount,
      imported: job.imported,
      updated: job.updated,
      rejected: job.rejected,
      state: failedEvent ? "failed" : completedEvent ? "completed" : "unknown",
      hasSummary,
    });
  }

  return enriched
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, limit);
}
