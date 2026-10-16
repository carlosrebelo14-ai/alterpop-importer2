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

/** Mensagem do estado falhado quando o ficheiro existe mas não se consegue ler (decisão 6). */
const MENSAGEM_ESTADO_ILEGIVEL = "estado de indexação ilegível";

function estadoSemIndexacao() {
  return { state: "idle", startedAt: null, finishedAt: null, error: null, totalRows: 0 };
}

/**
 * Ficheiro existente que não se lê, ou cujo JSON não é um objeto. Conta como falhado (decisão 6):
 * o ciclo não pode publicar sobre um estado que não se consegue ler.
 * @param {unknown} motivo
 */
function estadoIlegivel(motivo) {
  console.error("[catalogRebuildStatus] estado de indexação ilegível:", motivo);
  return {
    state: "failed",
    startedAt: null,
    finishedAt: null,
    error: MENSAGEM_ESTADO_ILEGIVEL,
    totalRows: 0,
    indexing: false,
    message: null,
  };
}

export async function readCatalogRebuildStatus(shop) {
  // During active indexing, serve from memory to avoid disk I/O contention.
  const mem = _memoryCache.get(shop);
  if (mem && (mem.state === "running" || mem.indexing === true)) {
    return mem;
  }
  return readCatalogRebuildStatusFromDisk(shop);
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

/**
 * Estado persistido em disco, sem a memória em execução. Para decidir a retoma (D5) e a publicação
 * do ciclo (decisão 6). Ficheiro inexistente é idle, que é a primeira execução. Ficheiro que não se
 * lê, ou cujo JSON não é um objeto, é failed.
 */
export async function readCatalogRebuildStatusFromDisk(shop) {
  let raw;
  try {
    raw = await fs.readFile(statusPath(shop), "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return estadoSemIndexacao();
    return estadoIlegivel(err?.message || err);
  }
  let lido;
  try {
    lido = JSON.parse(raw);
  } catch (err) {
    return estadoIlegivel(err?.message || err);
  }
  if (!lido || typeof lido !== "object" || Array.isArray(lido)) {
    return estadoIlegivel("o JSON não é um objeto");
  }
  return lido;
}

/**
 * Decisão 7 (DBG-69). O ciclo só publica com estado `completed` e `totalRows > 0`. Idle, running, paused,
 * interrupted, failed, aborted e estado ausente não publicam. `completed` sem linhas, sem `totalRows` ou com
 * `totalRows` que não é número também não publica. A Decisão 6 continua a valer: estado ilegível chega como failed.
 * @param {{ state?: unknown, error?: unknown, totalRows?: unknown } | null | undefined} estado
 * @returns {boolean}
 */
export function podePublicarDepoisDaIndexacao(estado) {
  if (!estado || typeof estado !== "object") return false;
  return estado.state === "completed" && !estado.error && Number.isFinite(estado.totalRows) && estado.totalRows > 0;
}
