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

  // Fix (code review 2026-08-13): NÃO persistir accessToken aqui — duplicava o token
  // OAuth em claro na coluna `payload` (SQLite), sem TTL, além do sítio onde já vive
  // (data/sessions/*.json). O worker carrega uma sessão fresca via
  // loadOfflineSessionForShop(shop) no momento de processar o job.
  const payload = JSON.stringify({
    settings,
    dryRun,
    filters,
    productsOnly,
    inventoryOnly,
    loadTest,
    session: { shop: session.shop },
  });

  // Auditoria 2026-09-22 — sem { rethrow: true }, uma falha aqui (ex.: SQLITE_BUSY
  // sob concorrência com o worker de reindexação) era engolida por safePrisma
  // (default rethrow:false) e a função seguia em frente como se tivesse enfileirado
  // com sucesso: escrevia status.json com state:"queued" e devolvia { state: "queued" }
  // ao caller. Como não existia linha na BackgroundImportJob, processNextQueuedJob()
  // (que só encontra trabalho via findFirst({ state: "queued" })) nunca descobria
  // este job — ficava "queued" para sempre, sem erro visível ao utilizador. Deixar
  // propagar aqui é o comportamento correto: é o pedido POST /api/import/start que
  // inicia o job, não um ciclo em fundo — se não conseguimos garantir que o job foi
  // mesmo enfileirado, o pedido deve falhar, não fingir sucesso.
  await safePrisma(
    "backgroundImportJob.create",
    () =>
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
      }),
    { rethrow: true }
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

  let fileStatus = null;
  try {
    fileStatus = JSON.parse(await fs.readFile(statusPath(jobId), "utf8"));
  } catch {
    fileStatus = null;
  }

  if (!row) {
    if (!fileStatus) return null;
    return { ok: true, ...fileStatus, progressPercent: fileStatus.progressPercent ?? 0 };
  }

  // Auditoria 2026-09-22 — updateBackgroundImportProgress() escreve sempre o
  // status.json, mesmo quando o prisma.backgroundImportJob.update() falha em
  // silêncio (safePrisma engole por omissão). Sem esta comparação, uma falha
  // pontual de escrita na BD (ex.: SQLITE_BUSY sob concorrência) deixava esta
  // função a devolver para sempre a linha antiga (ex.: "running"), mesmo depois do
  // job já ter terminado de verdade e o ficheiro já ter sido corrigido — nada lia
  // o ficheiro de volta enquanto existisse linha na BD. Quando os dois discordam
  // sobre o job já ter chegado a um estado terminal, o ficheiro é a fonte mais
  // recente (foi escrito na mesma chamada que tentou o update).
  const TERMINAL_STATES = new Set(["completed", "failed"]);
  const dbLooksStale =
    fileStatus && TERMINAL_STATES.has(fileStatus.state) && !TERMINAL_STATES.has(row.state);

  const state = dbLooksStale ? fileStatus.state : row.state;

  let summary = null;
  if (state === "completed" || state === "failed") {
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

  if (dbLooksStale) {
    return {
      ok: true,
      jobId: row.resultsJobId,
      queueId: row.id,
      shop: row.shop,
      state: fileStatus.state,
      progressPercent: fileStatus.progressPercent ?? 0,
      processedRows: fileStatus.processedRows ?? row.processedRows,
      totalRows: fileStatus.totalRows ?? row.totalRows,
      currentSku: fileStatus.currentSku ?? null,
      dryRun: row.dryRun,
      error: fileStatus.error ?? row.error,
      startedAt: fileStatus.startedAt ?? row.startedAt?.toISOString?.() ?? row.startedAt,
      finishedAt: fileStatus.finishedAt ?? row.finishedAt?.toISOString?.() ?? row.finishedAt,
      summary,
    };
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
