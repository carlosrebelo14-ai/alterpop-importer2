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
  if (child.exitCode !== null || child.signalCode !== null || child.killed) {
    activeChildren.delete(shop);
    return false;
  }
  return true;
}

/**
 * @param {string} shop
 * @param {object} settings
 * @param {{ runPurge?: boolean, resume?: boolean, forceFull?: boolean }} [opts]
 */
export async function startCatalogIndexingWorker(shop, settings, opts = {}) {
  if (opts.forceFull && activeChildren.has(shop)) {
    try { activeChildren.get(shop)?.kill("SIGKILL"); } catch { /* ignore */ }
    activeChildren.delete(shop);
  }

  if (activeChildren.has(shop)) {
    const existing = activeChildren.get(shop);
    if (!existing.killed && existing.exitCode === null && existing.signalCode === null) {
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

  const child = fork(
    workerPath,
    [
      JSON.stringify({
        shop,
        settings,
        runPurge: Boolean(opts.runPurge),
        resume,
        checkpointScanned,
      }),
    ],
    {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      env: { ...process.env },
    }
  );

  activeChildren.set(shop, child);

  writeCatalogRebuildStatus(shop, {
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
  }).catch(() => {});

  child.on("error", (err) => {
    console.error(`[indexingStream] Error in child worker process for ${shop}:`, err);
    activeChildren.delete(shop);
    broadcast(shop, { type: "error", message: err?.message || String(err) });
  });

  child.on("message", (msg) => {
    broadcast(shop, msg);

    if (msg?.type === "progress" && msg.indexed != null) {
      writeCatalogRebuildStatus(shop, {
        state: "running",
        totalRows: msg.indexed,
        scanned: msg.scanned,
        phase: msg.phase,
        checkpointScanned: msg.scanned,
        checkpointIndexed: msg.indexed,
      }).catch(() => {});
    }

    if (msg?.type === "done") {
      getCatalogProductTotal(shop).then((totalRows) => {
        writeCatalogRebuildStatus(shop, {
          state: "completed",
          finishedAt: msg.finishedAt || new Date().toISOString(),
          error: null,
          totalRows: totalRows || msg.indexed,
          indexing: false,
          audit: msg.audit || null,
          totalLinesRead: msg.totalLinesRead ?? msg.scanned,
          totalImported: msg.totalImported ?? msg.indexed,
          totalRejected: msg.totalRejected ?? 0,
          rejectionReasons: msg.rejectionReasons ?? {},
        }).catch(() => {});
      });
    }

    if (msg?.type === "error") {
      readCatalogRebuildStatus(shop).then((s) => {
        writeCatalogRebuildStatus(shop, {
          state: "failed",
          finishedAt: new Date().toISOString(),
          error: msg.message,
          indexing: false,
          checkpointScanned: s.checkpointScanned ?? s.scanned ?? null,
          checkpointIndexed: s.checkpointIndexed ?? s.totalRows ?? null,
          message: canResumeCatalogRebuild({ ...s, state: "failed" })
            ? "Indexação interrompida — podes retomar sem perder o progresso."
            : null,
        }).catch(() => {});
      });
    }
  });

  child.on("exit", (code) => {
    activeChildren.delete(shop);
    if (code !== 0) {
      readCatalogRebuildStatus(shop).then((s) => {
        if (s.state === "running" || s.indexing) {
          const failed = {
            state: "failed",
            finishedAt: new Date().toISOString(),
            error: s.error || (code == null ? "aborted" : `exit_${code}`),
            indexing: false,
            checkpointScanned: s.checkpointScanned ?? s.scanned ?? null,
            checkpointIndexed: s.checkpointIndexed ?? s.totalRows ?? null,
          };
          writeCatalogRebuildStatus(shop, {
            ...failed,
            message: canResumeCatalogRebuild({ ...s, ...failed })
              ? "Indexação interrompida — podes retomar sem perder o progresso."
              : null,
          }).catch(() => {});
        }
      });
    }
    broadcast(shop, { type: "closed" });
  });

  return child;
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
