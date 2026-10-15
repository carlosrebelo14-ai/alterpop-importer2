import fs from "fs/promises";
import path from "path";
import { getDefaultConfig } from "../config.js";

function statusPath(shop) {
  return path.join(
    getDefaultConfig().paths.data,
    "catalog-index",
    `${shop.replace(/\//g, "_")}-rebuild-status.json`
  );
}

/** In-memory status cache — avoids disk reads during active indexing. */
const _memoryCache = new Map();

export function setInMemoryStatus(shop, status) {
  const prev = _memoryCache.get(shop) || {};
  _memoryCache.set(shop, { ...prev, ...status });
}

export function getInMemoryStatus(shop) {
  return _memoryCache.get(shop) || null;
}

export function clearInMemoryStatus(shop) {
  _memoryCache.delete(shop);
}

export async function readCatalogRebuildStatus(shop) {
  // During active indexing, serve from memory to avoid disk I/O contention.
  const mem = _memoryCache.get(shop);
  if (mem && (mem.state === "running" || mem.indexing === true)) {
    return mem;
  }
  try {
    const raw = await fs.readFile(statusPath(shop), "utf8");
    return JSON.parse(raw);
  } catch {
    return { state: "idle", startedAt: null, finishedAt: null, error: null, totalRows: 0 };
  }
}

let _pendingWrite = new Map();

/**
 * Write status to disk — batched so concurrent calls don't hammer the FS.
 * During indexing, also updates the in-memory cache immediately.
 */
export async function writeCatalogRebuildStatus(shop, status) {
  // Always update memory immediately (O(1), non-blocking).
  setInMemoryStatus(shop, status);

  // Debounce disk writes: only write once per 5s per shop.
  if (_pendingWrite.has(shop)) return;
  _pendingWrite.set(shop, true);
  setTimeout(async () => {
    _pendingWrite.delete(shop);
    try {
      await fs.mkdir(path.dirname(statusPath(shop)), { recursive: true });
      const current = _memoryCache.get(shop) || {};
      let prev = {};
      try {
        const raw = await fs.readFile(statusPath(shop), "utf8");
        prev = JSON.parse(raw);
      } catch { /* file doesn't exist yet */ }
      await fs.writeFile(statusPath(shop), JSON.stringify({ ...prev, ...current }, null, 2));
    } catch (err) {
      console.error("[catalogRebuildStatus] Failed to persist status to disk:", err?.message);
    }
  }, 5000);
}

/**
 * Force an immediate disk write (used at completion/failure).
 */
export async function flushCatalogRebuildStatus(shop, status) {
  const merged = { ...(_memoryCache.get(shop) || {}), ...status };
  _memoryCache.set(shop, merged);
  try {
    await fs.mkdir(path.dirname(statusPath(shop)), { recursive: true });
    let prev = {};
    try {
      const raw = await fs.readFile(statusPath(shop), "utf8");
      prev = JSON.parse(raw);
    } catch { /* file doesn't exist yet */ }
    await fs.writeFile(statusPath(shop), JSON.stringify({ ...prev, ...merged }, null, 2));
  } catch (err) {
    console.error("[catalogRebuildStatus] Failed to flush status to disk:", err?.message);
  }
}

/**
 * Linha do CSV a partir da qual a indexação retoma. Só conta o checkpoint, que o worker grava
 * depois de o flush da fila confirmar (D5). O progresso (`scanned`) vai à frente e não serve.
 * @param {{ checkpointScanned?: unknown } | null | undefined} status
 */
export function pontoDeRetoma(status) {
  const n = Number(status?.checkpointScanned);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Indexação interrompida com checkpoint — pode retomar sem apagar SQLite. */
export function canResumeCatalogRebuild(status) {
  return (
    pontoDeRetoma(status) > 0 &&
    (status?.state === "failed" || status?.state === "interrupted") &&
    status?.indexing !== true
  );
}

/**
 * Estado em memória de um evento de progresso do worker. Não traz checkpoint (D5). O progresso
 * avança à frente do flush da fila, e o checkpoint só o worker o grava depois do flush confirmado.
 * @param {{ indexed?: number, scanned?: number, phase?: string }} msg
 */
export function estadoDoProgressoDoWorker(msg) {
  return { state: "running", totalRows: msg.indexed, scanned: msg.scanned, phase: msg.phase };
}

/** Estado persistido em disco, sem a memória em execução. Para decidir a retoma (D5). */
export async function readCatalogRebuildStatusFromDisk(shop) {
  try {
    return JSON.parse(await fs.readFile(statusPath(shop), "utf8"));
  } catch {
    return null;
  }
}
