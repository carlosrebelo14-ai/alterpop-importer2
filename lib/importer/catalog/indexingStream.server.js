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
  getInMemoryStatus,
  clearInMemoryStatus,
  canResumeCatalogRebuild,
  estadoDoProgressoDoWorker,
  pontoDeRetoma,
  readCatalogRebuildStatusFromDisk,
} from "./catalogRebuildStatus.server.js";
import { getCatalogProductTotal } from "./catalogProductsDb.server.js";
import {
  marcarAtividadeApp,
  motivoDeRecusaPorScript,
  scriptDeIndexacaoEmCurso,
} from "../../curation/atividadeApp.js";
import { registoDaFalha } from "./falhaIndexacao.js";
import { publicacaoOuResetEmCurso } from "../shopify/publicacaoEmCurso.js";

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
  // PR 5: o arranque conta como indexação em curso desde a reserva, antes de o filho existir (DBG-141).
  if (arranquesEmCurso.has(shop)) return true;
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

/**
 * Decisão 35 (D5). Função pura do evento `progress` do worker: entra a mensagem, sai a decisão de
 * atualizar a memória e o estado a gravar. O progresso não traz checkpoint: vai à frente do flush da
 * fila, e o checkpoint só o worker o grava depois do flush confirmado.
 * @param {{ indexed?: number | null, scanned?: number, phase?: string }} msg
 * @returns {{ atualizar: boolean, estado: { state: string, totalRows?: number, scanned?: number, phase?: string } | null }}
 */
export function decidirAtualizacaoDeProgresso(msg) {
  if (msg?.indexed == null) return { atualizar: false, estado: null };
  return { atualizar: true, estado: estadoDoProgressoDoWorker(msg) };
}

/**
 * Decisão 35 (D5). Trata o evento `progress` do worker. Emite o progresso aos subscritores, atualiza a
 * memória e pede a escrita do estado de rebuild. Não leva checkpoint. As dependências entram de fora,
 * para o teste correr sem fork nem disco. Devolve o estado em memória depois do evento.
 * @param {{ indexed?: number | null, scanned?: number, phase?: string }} msg
 * @param {{
 *   shop: string,
 *   estadoAtual: object | null,
 *   emitir: (shop: string, evento: object) => void,
 *   setInMemoryStatus: (shop: string, status: object) => void,
 *   writeCatalogRebuildStatus: (shop: string, status: object) => Promise<unknown>,
 * }} dependencias
 * @returns {object | null}
 */
export function tratarProgressoDoWorker(msg, dependencias) {
  const { shop, estadoAtual } = dependencias;
  dependencias.emitir(shop, { type: "progress", ...msg });
  const atualizacao = decidirAtualizacaoDeProgresso(msg);
  if (!atualizacao.atualizar) return estadoAtual;
  dependencias.setInMemoryStatus(shop, atualizacao.estado);
  // Escrita em disco com debounce, feita dentro de writeCatalogRebuildStatus.
  dependencias.writeCatalogRebuildStatus(shop, {}).catch(() => {});
  // Mesma junção que setInMemoryStatus faz com o estado anterior.
  return { ...estadoAtual, ...atualizacao.estado };
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
/** Fork do worker. Trocável só nos testes, por definirForkParaTestes. */
let forkDoWorker = fork;

/** Só para testes: troca o fork por um falso. Sem argumento, volta ao fork real. */
export function definirForkParaTestes(fn) {
  forkDoWorker = fn ?? fork;
}

/** Arranques ainda em curso, por loja (DBG-157). */
const arranquesEmCurso = new Map();

/**
 * Arranca a indexação em background. DBG-157: a reserva é feita antes de qualquer `await`. Um segundo
 * arranque no mesmo tick recebe a mesma promessa, e não faz um segundo fork. A reserva sai com sucesso ou
 * com falha (flush, marcador, fork).
 */
export function startCatalogIndexingWorker(shop, settings, opts = {}) {
  // PR 5 (DBG-140 e DBG-141): um script de reindexação vivo tem a loja. A app não arranca por cima dele. A recusa não
  // grava estado: o estado é do script, e um failed aqui apagava-o. Cobre o ciclo, o painel e a retoma.
  const recusaScript = motivoDeRecusaPorScript(scriptDeIndexacaoEmCurso());
  if (recusaScript) {
    console.error(`[indexacao] recusada (causa=script): ${recusaScript}`);
    return Promise.resolve(null);
  }
  // PR 5: simétrico da publicação manual. Uma publicação ou um reset com a reserva tomada não vê a indexação a arrancar
  // por baixo. A recusa aqui fecha a janela que a publicação deixaria aberta entre a sua verificação e a leitura do catálogo.
  if (publicacaoOuResetEmCurso()) {
    console.error("[indexacao] recusada (causa=publicacao): há uma publicação ou um reset Shopify em curso. Espera que termine.");
    return Promise.resolve(null);
  }
  if (arranquesEmCurso.has(shop)) return arranquesEmCurso.get(shop);
  const arranque = arrancarWorker(shop, settings, opts).finally(() => arranquesEmCurso.delete(shop));
  arranquesEmCurso.set(shop, arranque);
  return arranque;
}

async function arrancarWorker(shop, settings, opts = {}) {
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

  // DBG-155: o marcador nasce antes do fork, com o pid deste processo, e sem janela entre o fork e o marcador.
  // Decisão 35 (D7): quem escreve na fila vê a indexação desde o primeiro instante. O exit do worker retira-o.
  let retirarMarcador;
  try {
    // PR 5 (DBG-140 e DBG-141): uma corrida que um script arranca leva origem "script". Sem isto, a purga por script
    // era vista pela app como indexação da app.
    retirarMarcador = marcarAtividadeApp({ tipo: "indexacao", origem: opts.causa === "script" ? "script" : "app" });
  } catch (err) {
    const mensagem = `A indexação não arrancou. Não foi possível marcar a atividade da app (${err?.message || err}). Nada foi gravado.`;
    console.log(`[indexacao] fim causa=${causa} estado=falhou duracao_s=0`);
    // Só a causa vai para o log. O texto do erro fica no estado e no broadcast.
    console.error("[indexingStream] A indexação não arrancou: causa=marcador.");
    await flushCatalogRebuildStatus(shop, {
      state: "failed",
      finishedAt: new Date().toISOString(),
      error: mensagem,
      indexing: false,
      message: mensagem,
      lastFailure: registoDaFalha("marcador", mensagem),
    });
    broadcast(shop, { type: "error", message: mensagem });
    broadcast(shop, { type: "closed" });
    return null;
  }

  // Memória primeiro. O flush abaixo põe o mesmo estado no disco antes do fork.
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

  // DBG-156: o running tem de estar no disco antes do fork. Sem isto, o portão e o db:push leem um estado
  // parado durante o clearing, até ao primeiro flush com debounce (5 s depois do csv-cache).
  // DBG-157/154: se o estado não se gravar, não há fork. A indexação não arranca.
  if (!(await flushCatalogRebuildStatus(shop, {}))) {
    const mensagem = "A indexação não arrancou. Não foi possível gravar o estado no disco. Nada foi indexado.";
    console.log(`[indexacao] fim causa=${causa} estado=falhou duracao_s=0`);
    setInMemoryStatus(shop, {
      state: "failed",
      indexing: false,
      error: mensagem,
      finishedAt: new Date().toISOString(),
      lastFailure: registoDaFalha("estado_nao_gravado", mensagem),
    });
    await flushCatalogRebuildStatus(shop, {});
    retirarMarcador();
    console.error(`[indexingStream] ${mensagem}`);
    return null;
  }

  const isResume = resume && checkpointScanned > 0;
  const modo = opts.runPurge ? "purga" : isResume ? "retoma" : "completa";
  const t0 = Date.now();
  const duracaoS = () => Math.round((Date.now() - t0) / 1000);
  runInfo.set(shop, { causa, t0 });
  console.log(`[indexacao] inicio causa=${causa} modo=${modo}`);

  let child;
  try {
    child = forkDoWorker(
      workerPath,
      [JSON.stringify({ shop, settings, runPurge: !!opts.runPurge, resume, checkpointScanned })],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] }
    );
  } catch (err) {
    retirarMarcador();
    runInfo.delete(shop);
    console.log(`[indexacao] fim causa=${causa} estado=falhou duracao_s=${duracaoS()}`);
    throw err;
  }
  activeChildren.set(shop, child);

  child.stdout?.on("data", (chunk) => process.stdout.write(`[catalog-index-worker:${shop}] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[catalog-index-worker:${shop}] ${chunk}`));

  broadcast(shop, { type: "started", shop, resume, at: new Date().toISOString() });

  let settled = false;

  async function finishDone(msg) {
    if (settled) return;
    settled = true;
    runInfo.delete(shop);
    console.log(`[indexacao] fim causa=${causa} estado=concluida duracao_s=${duracaoS()} indexados=${msg.indexed ?? "?"}`);
    const gravado = await flushCatalogRebuildStatus(shop, {
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
    if (!gravado) {
      // DBG-154: sem o completed no disco, a corrida não se diz concluída.
      const mensagem = "Indexação concluída, mas o estado final não foi gravado no disco. Repetir a indexação.";
      console.error(`[indexingStream] ${mensagem}`);
      setInMemoryStatus(shop, {
        state: "failed",
        indexing: false,
        error: mensagem,
        finishedAt: new Date().toISOString(),
        lastFailure: registoDaFalha("estado_nao_gravado", mensagem),
      });
      await flushCatalogRebuildStatus(shop, {});
      broadcast(shop, { type: "error", message: mensagem });
      activeChildren.delete(shop);
      broadcast(shop, { type: "closed" });
      return;
    }

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

  async function finishFailed(errorMessage, causaFalha = "erro_worker") {
    if (settled) return;
    settled = true;
    runInfo.delete(shop);
    console.log(`[indexacao] fim causa=${causa} estado=falhou duracao_s=${duracaoS()}`);
    // DBG-152: o texto do erro fica no ficheiro de estado (lastFailure.error), nunca nos logs. Aqui só a causa.
    console.error(`[indexingStream] falha da indexação para ${shop}: causa=${causaFalha}`);
    broadcast(shop, { type: "error", message: errorMessage });
    // D5: a falha não repõe checkpoint. Fica o último que o worker gravou depois do flush confirmado.
    const emDisco = (await readCatalogRebuildStatusFromDisk(shop)) || {};

    const failed = {
      state: "failed",
      finishedAt: new Date().toISOString(),
      error: errorMessage,
      indexing: false,
      lastFailure: registoDaFalha(causaFalha, errorMessage),
    };

    const parcial = {
      ...failed,
      message: canResumeCatalogRebuild({ ...emDisco, ...failed })
        ? "Indexação interrompida — podes retomar sem perder o progresso."
        : null,
    };
    // DBG-154: uma repetição. Se também falhar, fica no log. O broadcast de erro já saiu.
    if (!(await flushCatalogRebuildStatus(shop, parcial))) {
      if (!(await flushCatalogRebuildStatus(shop, parcial))) {
        console.error(`[indexingStream] estado final da corrida falhada não gravado para ${shop}.`);
      }
    }
    clearInMemoryStatus(shop);

    activeChildren.delete(shop);
    broadcast(shop, { type: "closed" });
  }

  child.on("message", (msg) => {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "progress": {
        // D5. O progresso não é checkpoint (tratarProgressoDoWorker).
        tratarProgressoDoWorker(msg, {
          shop,
          estadoAtual: getInMemoryStatus(shop),
          emitir: broadcast,
          setInMemoryStatus,
          writeCatalogRebuildStatus,
        });
        break;
      }
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
        finishFailed(msg.message || "unknown worker error", "erro_worker").catch((err) =>
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
    finishFailed(errorMessage, signal ? "worker_morto" : "worker_saiu").catch((err) =>
      console.error(`[indexingStream] finishFailed (exit) falhou para ${shop}:`, err?.message || err)
    );
  });

  child.on("error", (err) => {
    if (activeChildren.get(shop) !== child) return;
    finishFailed(err?.message || String(err), "erro_pai").catch(() => {});
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
  // DBG-155: a promessa só resolve quando a corrida fecha, depois do estado final no disco (evento "closed").
  return new Promise((resolve, reject) => {
    const parar = subscribeIndexingEvents(shop, (evento) => {
      if (evento.type !== "closed") return;
      parar();
      resolve();
    });
    startCatalogIndexingWorker(shop, settings, { runPurge: true, resume: false, causa: opts.causa }).then(
      (child) => {
        // Sem fork não há "closed" a esperar (o arranque falhou e já ficou gravado).
        if (!child) {
          parar();
          resolve();
        }
      },
      (err) => {
        parar();
        reject(err);
      }
    );
  });
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
