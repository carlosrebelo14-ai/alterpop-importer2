import fs from "fs/promises";
import path from "path";
import { randomUUID } from "node:crypto";
import { getDefaultConfig } from "../config.js";
import {
  adquirirLockDoFicheiro,
  libertarLockDoFicheiro,
  titularAindaTemLock,
} from "../../curation/curationQueueFileLock.server.js";

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

/** Prazo do lock de ficheiro do estado. Curto, porque o flush do fim da corrida espera por ele. */
const PRAZO_LOCK_ESTADO_MS = 30_000;

/** Estado atual do ficheiro, para juntar a escrita. Ausente ou ilegível: objeto vazio. */
async function lerEstadoParaEscrita(ficheiro) {
  try {
    const lido = JSON.parse(await fs.readFile(ficheiro, "utf8"));
    return lido && typeof lido === "object" && !Array.isArray(lido) ? lido : {};
  } catch {
    return {};
  }
}

/**
 * Escreve o estado no disco com lock de ficheiro entre processos (DBG-154). App, worker e scripts escrevem
 * o mesmo ficheiro. Lê o que está no disco, junta `atualizacao` e grava por ficheiro temporário com rename,
 * para o ficheiro nunca ficar truncado. Um ficheiro ilegível é substituído pelo que se escreve. Um resultado
 * sem `state` nem `indexing` não se grava. Devolve false se algo falhar, e nunca lança.
 * @param {string} shop
 * @param {Record<string, unknown>} atualizacao
 * @returns {Promise<boolean>}
 */
async function escreverEstadoComLock(shop, atualizacao) {
  const ficheiro = statusPath(shop);
  let titular;
  try {
    await fs.mkdir(path.dirname(ficheiro), { recursive: true });
    titular = await adquirirLockDoFicheiro(`${ficheiro}.lock`, { prazoMs: PRAZO_LOCK_ESTADO_MS });
  } catch (err) {
    console.error("[catalogRebuildStatus] sem lock do estado, nada gravado:", err?.message);
    return false;
  }
  const temporario = `${ficheiro}.${process.pid}.${randomUUID()}.tmp`;
  try {
    if (!(await titularAindaTemLock(titular))) {
      console.error("[catalogRebuildStatus] o lock do estado já não é deste processo, nada gravado.");
      return false;
    }
    const novo = { ...(await lerEstadoParaEscrita(ficheiro)), ...atualizacao };
    if (novo.state === undefined && novo.indexing === undefined) {
      console.error("[catalogRebuildStatus] objeto sem state nem indexing, nada gravado.");
      return false;
    }
    await fs.writeFile(temporario, JSON.stringify(novo, null, 2));
    await fs.rename(temporario, ficheiro);
    return true;
  } catch (err) {
    await fs.unlink(temporario).catch(() => {});
    console.error("[catalogRebuildStatus] falha ao gravar o estado:", err?.message);
    return false;
  } finally {
    await libertarLockDoFicheiro(titular);
  }
}

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
  setTimeout(() => {
    _pendingWrite.delete(shop);
    escreverEstadoComLock(shop, _memoryCache.get(shop) || {});
  }, 5000);
}

/**
 * Grava já, sem debounce, com o mesmo lock. Devolve true se o estado ficou no disco e false se não (DBG-154).
 * O chamador decide o que fazer com a falha: o fim da corrida não se diz concluído sem isto.
 * @returns {Promise<boolean>}
 */
export async function flushCatalogRebuildStatus(shop, status) {
  const merged = { ...(_memoryCache.get(shop) || {}), ...status };
  _memoryCache.set(shop, merged);
  return escreverEstadoComLock(shop, merged);
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
