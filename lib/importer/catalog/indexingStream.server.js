import { fork } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
/**
 * Indexação em background (fork → catalog-index-worker).
 * Filtro CSV: syncCatalogWithProgress → csvFieldMap → normalizeCategory → structuredCatalogFilter
 * (short-circuit elite: marca/título/tags antes de preço ou papelaria).
 */
import {
  readCatalogRebuildStatus,
  writeCatalogRebuildStatus,
  flushCatalogRebuildStatus,
  setInMemoryStatus,
  clearInMemoryStatus,
  canResumeCatalogRebuild,
} from "./catalogRebuildStatus.server.js";
import { getCatalogProductTotal } from "./catalogProductsDb.server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerPath = fs.existsSync(path.join(__dirname, "../../workers/catalog-index-worker.mjs"))
  ? path.join(__dirname, "../../workers/catalog-index-worker.mjs")
  : path.join(process.cwd(), "lib/workers/catalog-index-worker.mjs");

/** @type {Map<string, import('child_process').ChildProcess>} */
const activeChildren = new Map();

/** @type {Map<string, Set<(event: object) => void>>} */
const subscribers = new Map();

function getSubs(shop) {
  if (!subscribers.has(shop)) subscribers.set(shop, new Set());
  return subscribers.get(shop);
}

function broadcast(shop, event) {
  for (const fn of getSubs(shop)) {
    try {
      fn(event);
    } catch {
      /* ignore */
    }
  }
}

export function subscribeIndexingEvents(shop, listener) {
  const set = getSubs(shop);
  set.add(listener);
  return () => set.delete(listener);
}

export function isCatalogIndexingRunning(shop) {
  const child = activeChildren.get(shop);
  if (!child) return false;
  if (child.exitCode != null || child.signalCode != null || child.killed) {
    activeChildren.delete(shop);
    return false;
  }
  return true;
}

export async function stopCatalogIndexingWorker(shop) {
  const child = activeChildren.get(shop);
  if (child) {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
    activeChildren.delete(shop);
  }
  await writeCatalogRebuildStatus(shop, {
    state: "paused",
    indexing: false,
    message: "Indexação pausada pelo utilizador.",
  });
  broadcast(shop, { type: "paused", shop });
  return true;
}

/**
 * @param {string} shop
 * @param {object} settings
 * @param {{ runPurge?: boolean, resume?: boolean, forceFull?: boolean }} [opts]
 */
export async function startCatalogIndexingWorker(shop, settings, opts = {}) {
  if (opts.forceFull && activeChildren.has(shop)) {
    try { activeChildren.get(shop)?.kill("SIGTERM"); } catch { /* ignore */ }
    activeChildren.delete(shop);
  }

  if (activeChildren.has(shop)) {
    const existing = activeChildren.get(shop);
    if (!existing.killed && existing.exitCode == null && existing.signalCode == null) {
      return existing;
    }
    activeChildren.delete(shop);
  }

  const prevStatus = await readCatalogRebuildStatus(shop);
  const resume =
    !opts.runPurge &&
    (opts.resume === true || (opts.resume !== false && canResumeCatalogRebuild(prevStatus)));
  const checkpointScanned = resume
    ? Number(prevStatus.checkpointScanned ?? prevStatus.scanned ?? 0)
    : 0;

  import("../curation/dynamicRules.server.js")
    .then(({ primeMarketSettingsForShop, setActiveMarketShop }) =>
      primeMarketSettingsForShop(shop).then(() => setActiveMarketShop(shop))
    )
    .catch(() => {});

  activeChildren.set(shop, { killed: false });

  // Update memory immediately — no disk I/O, so the event loop stays free.
  setInMemoryStatus(shop, {
    state: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    totalRows: resume ? prevStatus.checkpointIndexed ?? prevStatus.totalRows ?? 0 : 0,
    indexing: true,
    resumedFrom: resume ? checkpointScanned : null,
    message: resume
      ? `A retomar indexação (linha ${checkpointScanned.toLocaleString("pt-PT")} do CSV)…`
      : null,
  });

  (async () => {
    try {
      const { syncCatalogWithProgress } = await import("./syncCatalogWithProgress.server.js");
      const { purgeDatabase } = await import("./purgeDatabase.server.js");
      const { ensureLocalOcioStockCsv } = await import("./ensureLocalOcioStockCsv.server.js");

      broadcast(shop, { type: "started", shop, resume, at: new Date().toISOString() });
      broadcast(shop, { type: "progress", phase: "csv-cache", indexed: 0, scanned: 0 });
      await ensureLocalOcioStockCsv(shop, settings);

      if (opts.runPurge) {
        broadcast(shop, { type: "progress", phase: "purge", indexed: 0, scanned: 0 });
        const purge = await purgeDatabase(shop);
        broadcast(shop, { type: "purge_done", purge });
      }

      const resumeFromScanned = resume ? Math.max(0, Number(checkpointScanned) || 0) : 0;
      const isResume = resumeFromScanned > 0;

      if (isResume) {
        broadcast(shop, {
          type: "progress",
          phase: "resuming",
          indexed: 0,
          scanned: resumeFromScanned,
          resumedFrom: resumeFromScanned,
        });
      }

      const result = await syncCatalogWithProgress(shop, settings, {
        clearFirst: !isResume && !opts.runPurge,
        resumeFromScanned,
        onProgress(stats) {
          if (!activeChildren.has(shop)) throw new Error("aborted");
          broadcast(shop, { type: "progress", ...stats });
          // Memory-only update (no disk I/O) so SQLite is never starved.
          if (stats.indexed != null) {
            setInMemoryStatus(shop, {
              state: "running",
              totalRows: stats.indexed,
              scanned: stats.scanned,
              phase: stats.phase,
              checkpointScanned: stats.scanned,
              checkpointIndexed: stats.indexed,
            });
            // Debounced disk flush handled inside writeCatalogRebuildStatus.
            writeCatalogRebuildStatus(shop, {}).catch(() => {});
          }
        },
        onCheckpoint({ indexed, scanned }) {
          // Memory-only — the debounced writer will persist later.
          setInMemoryStatus(shop, {
            checkpointScanned: scanned,
            checkpointIndexed: indexed,
            scanned,
            totalRows: indexed,
          });
        },
      });

      await flushCatalogRebuildStatus(shop, {
        checkpointScanned: null,
        checkpointIndexed: null,
        resumedFrom: null,
        message: null,
        state: "completed",
        finishedAt: new Date().toISOString(),
        error: null,
        totalRows: result.indexed,
        indexing: false,
        audit: result.audit || null,
        totalLinesRead: result.audit?.totalLinesRead ?? result.scanned,
        totalImported: result.audit?.totalImported ?? result.indexed,
        totalRejected: result.audit?.totalRejected ?? 0,
        rejectionReasons: result.audit?.rejectionReasons ?? {},
      });

      // Reindexação completa (não resumida) reconstrói a fila de curadoria do zero —
      // sem isto, SyncErrorLog acumulava erros de execuções antigas indefinidamente,
      // já que nada mais o limpava, dessincronizando com curation-queue.json.
      if (!isResume) {
        import("../sync/syncErrorLog.server.js")
          .then(({ deactivateAllSyncErrors }) => deactivateAllSyncErrors(shop))
          .catch(() => {});
      }

      // Item 2/3 — novidades e descontinuados: só faz sentido comparar contra o ciclo
      // anterior quando o CSV foi lido do início (resume parcial não tem visão completa
      // de quem "desapareceu"). Não bloqueia o fim da indexação nem o publish a seguir.
      if (!isResume) {
        import("./skuLifecycle.server.js")
          .then(({ runSkuLifecycleCycle }) => runSkuLifecycleCycle(shop))
          .catch((err) => console.error("[indexingStream] skuLifecycle falhou:", err?.message || err));
      }

      clearInMemoryStatus(shop);

      broadcast(shop, {
        type: "done",
        indexed: result.indexed,
        scanned: result.scanned,
        finishedAt: new Date().toISOString(),
        audit: result.audit || null,
        totalLinesRead: result.audit?.totalLinesRead ?? result.scanned,
        totalImported: result.audit?.totalImported ?? result.indexed,
        totalRejected: result.audit?.totalRejected ?? 0,
        rejectionReasons: result.audit?.rejectionReasons ?? {},
      });
      activeChildren.delete(shop);
      broadcast(shop, { type: "closed" });

    } catch (err) {
      activeChildren.delete(shop);
      const aborted = err.message === "aborted";
      if (!aborted) console.error(`[indexingStream] Error in worker process for ${shop}:`, err);
      
      broadcast(shop, { type: "error", message: err?.message || String(err) });
      const s = readCatalogRebuildStatus(shop) || {};
      const sMem = (await Promise.resolve(s));
      
      const failed = {
        state: "failed",
        finishedAt: new Date().toISOString(),
        error: aborted ? "aborted" : err.message,
        indexing: false,
        checkpointScanned: sMem.checkpointScanned ?? sMem.scanned ?? null,
        checkpointIndexed: sMem.checkpointIndexed ?? sMem.totalRows ?? null,
      };
      
      await flushCatalogRebuildStatus(shop, {
        ...failed,
        message: canResumeCatalogRebuild({ ...sMem, ...failed })
          ? "Indexação interrompida — podes retomar sem perder o progresso."
          : null,
      }).catch(() => {});
      clearInMemoryStatus(shop);
      
      broadcast(shop, { type: "closed" });
    }
  })();

  return { killed: false };
}

export function startCatalogCleanupInBackground(shop, settings) {
  void startCatalogIndexingWorker(shop, settings, { runPurge: true, resume: false });
}

/**
 * @param {string} shop
 * @param {object} settings
 * @param {{ resume?: boolean, forceFull?: boolean }} [opts]
 */
export function startCatalogRebuildInBackground(shop, settings, opts = {}) {
  void startCatalogIndexingWorker(shop, settings, {
    runPurge: false,
    resume: opts.forceFull ? false : opts.resume,
  });
}

export { readCatalogRebuildStatus, isCatalogIndexingRunning as isCatalogRebuildRunning };
