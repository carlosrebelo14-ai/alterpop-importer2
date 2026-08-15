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

  const isResume = resume && checkpointScanned > 0;

  const child = fork(
    workerPath,
    [JSON.stringify({ shop, settings, runPurge: !!opts.runPurge, resume, checkpointScanned })],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] }
  );
  activeChildren.set(shop, child);

  child.stdout?.on("data", (chunk) => process.stdout.write(`[catalog-index-worker:${shop}] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[catalog-index-worker:${shop}] ${chunk}`));

  broadcast(shop, { type: "started", shop, resume, at: new Date().toISOString() });

  let settled = false;

  async function finishDone(msg) {
    if (settled) return;
    settled = true;
    await flushCatalogRebuildStatus(shop, {
      checkpointScanned: null,
      checkpointIndexed: null,
      resumedFrom: null,
      message: null,
      state: "completed",
      finishedAt: new Date().toISOString(),
      error: null,
      totalRows: msg.indexed,
      indexing: false,
      audit: msg.audit || null,
      totalLinesRead: msg.totalLinesRead ?? msg.scanned,
      totalImported: msg.totalImported ?? msg.indexed,
      totalRejected: msg.totalRejected ?? 0,
      rejectionReasons: msg.rejectionReasons ?? {},
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
      indexed: msg.indexed,
      scanned: msg.scanned,
      finishedAt: new Date().toISOString(),
      audit: msg.audit || null,
      totalLinesRead: msg.totalLinesRead ?? msg.scanned,
      totalImported: msg.totalImported ?? msg.indexed,
      totalRejected: msg.totalRejected ?? 0,
      rejectionReasons: msg.rejectionReasons ?? {},
    });
    activeChildren.delete(shop);
    broadcast(shop, { type: "closed" });
  }

  async function finishFailed(errorMessage) {
    if (settled) return;
    settled = true;
    console.error(`[indexingStream] Error in worker process for ${shop}:`, errorMessage);
    broadcast(shop, { type: "error", message: errorMessage });
    const sMem = (await readCatalogRebuildStatus(shop)) || {};

    const failed = {
      state: "failed",
      finishedAt: new Date().toISOString(),
      error: errorMessage,
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

    activeChildren.delete(shop);
    broadcast(shop, { type: "closed" });
  }

  child.on("message", (msg) => {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "progress":
        broadcast(shop, { type: "progress", ...msg });
        if (msg.indexed != null) {
          setInMemoryStatus(shop, {
            state: "running",
            totalRows: msg.indexed,
            scanned: msg.scanned,
            phase: msg.phase,
            checkpointScanned: msg.scanned,
            checkpointIndexed: msg.indexed,
          });
          // Debounced disk flush handled inside writeCatalogRebuildStatus.
          writeCatalogRebuildStatus(shop, {}).catch(() => {});
        }
        break;
      case "purge_done":
        broadcast(shop, { type: "purge_done", purge: msg.purge });
        break;
      case "done":
        finishDone(msg).catch((err) =>
          console.error(`[indexingStream] finishDone falhou para ${shop}:`, err?.message || err)
        );
        break;
      case "error":
        finishFailed(msg.message || "unknown worker error").catch((err) =>
          console.error(`[indexingStream] finishFailed falhou para ${shop}:`, err?.message || err)
        );
        break;
      default:
        break;
    }
  });

  child.on("exit", (code, signal) => {
    // Só trata como crash se ninguém já processou "done"/"error" (esses já fizeram delete).
    if (activeChildren.get(shop) !== child) return;
    const errorMessage = signal
      ? `worker process killed (${signal})`
      : `worker process exited with code ${code}`;
    finishFailed(errorMessage).catch((err) =>
      console.error(`[indexingStream] finishFailed (exit) falhou para ${shop}:`, err?.message || err)
    );
  });

  child.on("error", (err) => {
    if (activeChildren.get(shop) !== child) return;
    finishFailed(err?.message || String(err)).catch(() => {});
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
