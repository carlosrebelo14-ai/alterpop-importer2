import fs from "fs/promises";
import path from "path";
import { getDefaultConfig } from "../config.js";

function normalizeJob(raw, fallbackId) {
  const jobId = String(raw?.jobId ?? raw?.id ?? fallbackId ?? "");
  const metrics =
    raw?.metrics && typeof raw.metrics === "object" && !Array.isArray(raw.metrics)
      ? raw.metrics
      : undefined;

  return {
    jobId,
    status: raw?.status ?? raw?.state ?? "unknown",
    state: raw?.state ?? raw?.status,
    mode: raw?.mode != null ? String(raw.mode) : "-",
    startedAt: raw?.startedAt != null ? String(raw.startedAt) : "-",
    finishedAt: raw?.finishedAt != null ? String(raw.finishedAt) : null,
    metrics,
    error: raw?.error != null ? String(raw.error) : null,
    processedRows: raw?.processedRows,
    totalRows: raw?.totalRows,
    progressPercent: raw?.progressPercent,
    currentSku: raw?.currentSku != null ? String(raw.currentSku) : null,
  };
}

export async function listImportJobs(limit = 50) {
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
    const dir = path.join(resultsDir, ent.name);
    try {
      const summaryRaw = await fs.readFile(path.join(dir, "summary.json"), "utf8");
      jobs.push(normalizeJob(JSON.parse(summaryRaw), ent.name));
    } catch {
      try {
        const statusRaw = await fs.readFile(path.join(dir, "status.json"), "utf8");
        const status = JSON.parse(statusRaw);
        jobs.push(
          normalizeJob(
            {
              jobId: status.jobId ?? ent.name,
              status: status.state,
              state: status.state,
              mode: status.summary?.mode,
              startedAt: status.startedAt,
              finishedAt: status.finishedAt,
              metrics: status.summary?.metrics,
              error: status.error,
              processedRows: status.processedRows,
              totalRows: status.totalRows,
              progressPercent: status.progressPercent,
              currentSku: status.currentSku,
            },
            ent.name
          )
        );
      } catch {
        jobs.push(
          normalizeJob(
            { jobId: ent.name, status: "unknown", error: "Dados do job ilegíveis" },
            ent.name
          )
        );
      }
    }
  }

  return jobs
    .filter((j) => j.jobId)
    .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")))
    .slice(0, limit);
}

export async function getLatestJob() {
  const jobs = await listImportJobs(1);
  return jobs[0] || null;
}
