import { fork } from "child_process";
import fs from "fs";
import path from "path";
import { assertDbNotDegraded } from "../../health/dbDegraded.js";
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
  estadoDoProgressoDoWorker,
  pontoDeRetoma,
  readCatalogRebuildStatusFromDisk,
} from "./catalogRebuildStatus.server.js";
import { getCatalogProductTotal } from "./catalogProductsDb.server.js";
import { marcarAtividadeApp } from "../../curation/atividadeApp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerPath = fs.existsSync(path.join(__dirname, "../../workers/catalog-index-worker.mjs"))
  ? path.join(__dirname, "../../workers/catalog-index-worker.mjs")
  : path.join(process.cwd(), "lib/workers/catalog-index-worker.mjs");

/** @type {Map<string, import('child_process').ChildProcess>} */
const activeChildren = new Map();

/**
 * Quem arrancou a indexação. Vai para o log como `causa=` (DBG-06 do relatório de 14/10:
 * não se via no logs_recent quem tinha arrancado a corrida de mais de 20 min).
 * `painel` = botão do painel; `ciclo` = trigger-sync; `script` = linha de comandos.
 */
const CAUSAS_INDEXACAO = new Set(["painel", "ciclo", "script"]);

/** shop → { causa, t0 } da corrida em curso, para o log de paragem. */
const runInfo = new Map();

/** Escritas da fila que o worker manda em lotes (Decisão 35, D1). Cada pedido regista a duração. */
const OPS_LOTE_FILA = new Set(["flushCurationQueueItems", "upsertCurationQueueBatchFromRecords"]);

/**
 * Decisão 35 (D1). O worker pede uma escrita da fila, e só o principal escreve. Num lote de fila,
 * a duração vai até à resposta (inclui a espera pelo lock, Decisão 6). A linha tem só números:
 * sem SKU nem texto de loja.
 * @param {string} shop
 * @param {{ op?: string, args?: unknown[] }} msg
 * @param {import('child_process').ChildProcess} child
 */
function atenderEscritaDaFila(shop, msg, child) {
  const chegada = Date.now();
  const lote = OPS_LOTE_FILA.has(msg?.op);
  const itens = lote && Array.isArray(msg.args?.[0]) ? msg.args[0].length : 0;
  import("../../curation/curationQueue.server.js")
    .then((fila) =>
      fila.handleCurationWriteMessage(msg, (resposta) => {
        if (lote) console.log(`[indexacao] lote-fila duracao_ms=${Date.now() - chegada} itens=${itens}`);
        child.send(resposta, () => {});
      })
    )
    .catch((err) => console.error(`[indexingStream] escrita da fila falhou para ${shop}:`, err?.message || err));
}

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

/** Fecha no log uma corrida interrompida sem passar por finishFailed (paragem ou substituição). */
function registarInterrupcao(shop) {
  const info = runInfo.get(shop);
  if (!info) return;
  runInfo.delete(shop);
  console.log(`[indexacao] fim causa=${info.causa} estado=parada duracao_s=${Math.round((Date.now() - info.t0) / 1000)}`);
}

export async function stopCatalogIndexingWorker(shop) {
  const child = activeChildren.get(shop);
  if (child) {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
    activeChildren.delete(shop);
  }
  registarInterrupcao(shop);
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
  const causa = CAUSAS_INDEXACAO.has(opts.causa) ? opts.causa : "desconhecida";
  if (opts.forceFull && activeChildren.has(shop)) {
    try { activeChildren.get(shop)?.kill("SIGTERM"); } catch { /* ignore */ }
    activeChildren.delete(shop);
    registarInterrupcao(shop);
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
  // D5: a retoma parte só do checkpoint gravado depois do flush confirmado, nunca do progresso.
  const checkpointScanned = resume ? pontoDeRetoma(prevStatus) : 0;

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
  const modo = opts.runPurge ? "purga" : isResume ? "retoma" : "completa";
  const t0 = Date.now();
  const duracaoS = () => Math.round((Date.now() - t0) / 1000);
  runInfo.set(shop, { causa, t0 });
  console.log(`[indexacao] inicio causa=${causa} modo=${modo}`);

  let child;
  try {
    child = fork(
      workerPath,
      [JSON.stringify({ shop, settings, runPurge: !!opts.runPurge, resume, checkpointScanned })],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] }
    );
  } catch (err) {
    runInfo.delete(shop);
    console.log(`[indexacao] fim causa=${causa} estado=falhou duracao_s=${duracaoS()}`);
    throw err;
  }
  activeChildren.set(shop, child);

  // Decisão 35 (D7): enquanto o worker vive, os scripts que escrevem a fila recusam. O marcador
  // leva o pid do worker, por isso uma sobra de crash deixa de contar quando o processo morre.
  let retirarMarcador = () => {};
  try {
    retirarMarcador = marcarAtividadeApp({ tipo: "indexacao", pid: child.pid });
  } catch (err) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* já terminou */
    }
    activeChildren.delete(shop);
    runInfo.delete(shop);
    throw err;
  }

  child.stdout?.on("data", (chunk) => process.stdout.write(`[catalog-index-worker:${shop}] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[catalog-index-worker:${shop}] ${chunk}`));

  broadcast(shop, { type: "started", shop, resume, at: new Date().toISOString() });

  let settled = false;

  async function finishDone(msg) {
    if (settled) return;
    settled = true;
    runInfo.delete(shop);
    console.log(`[indexacao] fim causa=${causa} estado=concluida duracao_s=${duracaoS()} indexados=${msg.indexed ?? "?"}`);
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
    runInfo.delete(shop);
    console.log(`[indexacao] fim causa=${causa} estado=falhou duracao_s=${duracaoS()}`);
    console.error(`[indexingStream] Error in worker process for ${shop}:`, errorMessage);
    broadcast(shop, { type: "error", message: errorMessage });
    // D5: a falha não repõe checkpoint. Fica o último que o worker gravou depois do flush confirmado.
    const emDisco = (await readCatalogRebuildStatusFromDisk(shop)) || {};

    const failed = {
      state: "failed",
      finishedAt: new Date().toISOString(),
      error: errorMessage,
      indexing: false,
    };

    await flushCatalogRebuildStatus(shop, {
      ...failed,
      message: canResumeCatalogRebuild({ ...emDisco, ...failed })
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
          // D5: o progresso não é checkpoint. Vai à frente do flush da fila; o checkpoint vem do worker.
          setInMemoryStatus(shop, estadoDoProgressoDoWorker(msg));
          // Debounced disk flush handled inside writeCatalogRebuildStatus.
          writeCatalogRebuildStatus(shop, {}).catch(() => {});
        }
        break;
      case "purge_done":
        broadcast(shop, { type: "purge_done", purge: msg.purge });
        break;
      case "curation-write":
        atenderEscritaDaFila(shop, msg, child);
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
    retirarMarcador();
    // Só trata como crash se ninguém já processou "done"/"error" (esses já fizeram delete).
    if (activeChildren.get(shop) !== child) return;
    // Saída sem "done" nem "error": o worker morreu a meio (reinício). Conta-se no logs_recent.
    if (!settled) console.error(`[indexacao] worker terminou sem concluir (code=${code} signal=${signal})`);
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

/**
 * @param {string} shop
 * @param {object} settings
 * @param {{ causa?: "painel" | "ciclo" | "script" }} [opts]
 */
export function startCatalogCleanupInBackground(shop, settings, opts = {}) {
  assertDbNotDegraded("purga do catálogo");
  void startCatalogIndexingWorker(shop, settings, { runPurge: true, resume: false, causa: opts.causa });
}

/**
 * @param {string} shop
 * @param {object} settings
 * @param {{ resume?: boolean, forceFull?: boolean, causa?: "painel" | "ciclo" | "script" }} [opts]
 */
export function startCatalogRebuildInBackground(shop, settings, opts = {}) {
  assertDbNotDegraded("reindexação do catálogo");
  void startCatalogIndexingWorker(shop, settings, {
    runPurge: false,
    resume: opts.forceFull ? false : opts.resume,
    causa: opts.causa,
  });
}

export { readCatalogRebuildStatus, isCatalogIndexingRunning as isCatalogRebuildRunning };
