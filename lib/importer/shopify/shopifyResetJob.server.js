import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { getDefaultConfig } from "../config.js";
import {
  adquirirLockDoFicheiro,
  libertarLockDoFicheiro,
} from "../../curation/curationQueueFileLock.server.js";

/** @typedef {'idle'|'running'|'listing'|'deleting'|'completed'|'failed'} ShopifyResetJobState */

/**
 * @typedef {object} ShopifyResetJobStatus
 * @property {string|null} jobId
 * @property {string} shop
 * @property {ShopifyResetJobState} state
 * @property {number} total
 * @property {number} processed
 * @property {number} deleted
 * @property {number} failed
 * @property {number} revertedLocal
 * @property {string|null} currentTitle
 * @property {string|null} error
 * @property {string|null} startedAt
 * @property {string|null} finishedAt
 * @property {string|null} updatedAt batimento: cada escrita renova-o (D39)
 * @property {string|null} retomadoDe jobId do reset interrompido que este retoma, ou null
 * @property {string|null} inicioDoPrimeiroArranque instante em que a primeira tentativa deste reset arrancou. A retoma
 *   herda-o, para o D2 (decisão humana depois desse instante ganha ao apagamento).
 * @property {{ productId: string, message: string }[]} recentErrors
 */

/** Estados em que o reset ainda pode estar a mexer na loja e na fila. */
const ESTADOS_ATIVOS = new Set(["running", "listing", "deleting"]);

/**
 * D39 (Decisão 35): um reset sem batimento há 10 minutos conta como morto. Deixa de bloquear a rota e a publicação,
 * e pode ser retomado. Cada escrita do estado renova o `updatedAt`, e enquanto o processo vive um batimento renova-o
 * de minuto a minuto (iniciarBatimento), mesmo com a Shopify em silêncio.
 */
export const RESET_EXPIRA_MS = 10 * 60 * 1000;
const BATIMENTO_MS = 60 * 1000;
/** Espera pelo trinco de arranque. Dentro dele não se faz nada além de ler e escrever o estado. */
const PRAZO_DO_TRINCO_DE_ARRANQUE_MS = 5000;

function statusPath(shop) {
  return path.join(
    getDefaultConfig().paths.data,
    "shopify-reset",
    `${shop.replace(/\//g, "_")}-status.json`
  );
}

/** Trinco entre processos para o arranque (purga CLI e app podem arrancar no mesmo instante). */
function trincoDoArranque(shop) {
  return statusPath(shop).replace(/-status\.json$/, "-reset.lock");
}

function numero(valor) {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Estado do reset. Ficheiro em falta: idle. Ficheiro que não se lê como JSON: `ilegivel: true` em estado `running`,
 * porque não se sabe se há um reset vivo. Fail closed (DBG-30, morte a meio de uma escrita).
 * @param {string} shop
 */
export async function readShopifyResetStatus(shop) {
  try {
    const raw = await fs.readFile(statusPath(shop), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      return {
        jobId: null,
        shop,
        state: "running",
        ilegivel: true,
        total: 0,
        processed: 0,
        deleted: 0,
        failed: 0,
        revertedLocal: 0,
        currentTitle: null,
        error: "Estado do reset ilegível. Não se sabe se há um reset em curso.",
        startedAt: null,
        finishedAt: null,
        updatedAt: null,
        retomadoDe: null,
        recentErrors: [],
      };
    }
    return {
      jobId: null,
      shop,
      state: "idle",
      total: 0,
      processed: 0,
      deleted: 0,
      failed: 0,
      revertedLocal: 0,
      currentTitle: null,
      error: null,
      startedAt: null,
      finishedAt: null,
      updatedAt: null,
      retomadoDe: null,
      recentErrors: [],
    };
  }
}

/** Escritas do mesmo reset em fila, para não se perderem atualizações (o progresso da listagem não tem await). */
const escritasPorLoja = new Map();

function emSequencia(shop, tarefa) {
  const anterior = escritasPorLoja.get(shop) ?? Promise.resolve();
  const atual = anterior.catch(() => {}).then(tarefa);
  escritasPorLoja.set(shop, atual.catch(() => {}));
  return atual;
}

/**
 * Escrita atómica (ficheiro temporário com nome único e renomeação), para que uma morte a meio não deixe JSON
 * cortado. Renova o `updatedAt` (batimento, D39). A leitura e a escrita não têm lock entre processos: o reset corre num só.
 * @param {string} shop
 * @param {Partial<ShopifyResetJobStatus>} patch
 */
export async function writeShopifyResetStatus(shop, patch) {
  return emSequencia(shop, async () => {
    const destino = statusPath(shop);
    await fs.mkdir(path.dirname(destino), { recursive: true });
    const prev = await readShopifyResetStatus(shop);
    const { ilegivel: _ilegivel, ...base } = prev;
    const next = {
      ...base,
      shop,
      ...patch,
      recentErrors: patch.recentErrors ?? prev.recentErrors ?? [],
      updatedAt: new Date().toISOString(),
    };
    const temporario = `${destino}.${randomUUID()}.tmp`;
    await fs.writeFile(temporario, JSON.stringify(next, null, 2), "utf8");
    await fs.rename(temporario, destino);
    return next;
  });
}

/**
 * Um reset está vivo se está num estado ativo e tem batimento dentro do prazo (D39). Estado ilegível conta como vivo.
 * @param {ShopifyResetJobStatus} status
 * @param {number} [agora]
 */
export function resetEstaVivo(status, agora = Date.now()) {
  if (!ESTADOS_ATIVOS.has(status?.state)) return false;
  if (status.ilegivel) return true;
  const sinal = Date.parse(status.updatedAt || status.startedAt || "");
  if (!Number.isFinite(sinal)) return true;
  return agora - sinal <= RESET_EXPIRA_MS;
}

/**
 * @param {string} shop
 * @param {number} [agora]
 */
export async function isShopifyResetRunning(shop, agora = Date.now()) {
  return resetEstaVivo(await readShopifyResetStatus(shop), agora);
}

/**
 * Arranca um reset. Recusa-se se outro reset estiver vivo (segunda guarda, além da rota).
 * Se o anterior morreu (D39), retoma-se: o apagado e o revertido localmente contam-se uma vez, e a listagem da loja
 * já não traz os produtos apagados, por isso não há DELETE repetido. Os falhados não se somam: são tentados outra vez.
 * @param {string} shop
 * @param {number} [agora]
 */
export async function initShopifyResetJob(shop, agora = Date.now()) {
  // Entre processos (purga CLI e app): ler, verificar e escrever fazem-se dentro do mesmo trinco. Sem ele, duas
  // chamadas no mesmo instante passam ambas a verificação e arrancam dois resets sobre a mesma loja.
  const trinco = await adquirirLockDoFicheiro(trincoDoArranque(shop), {
    prazoMs: PRAZO_DO_TRINCO_DE_ARRANQUE_MS,
    rotulo: "[reset] arranque ocupado por outro processo",
  });
  try {
    const anterior = await readShopifyResetStatus(shop);
    if (resetEstaVivo(anterior, agora)) {
      throw new Error("Já existe um reset Shopify em curso.");
    }
    const retoma = ESTADOS_ATIVOS.has(anterior.state);
    const inicio = new Date(agora).toISOString();
    // D2 na retoma: o instante do primeiro arranque é o que conta, e não o da retoma. Assim a decisão humana tomada
    // durante a tentativa interrompida continua a ganhar ao apagamento.
    const inicioOriginal = retoma ? anterior.inicioDoPrimeiroArranque || anterior.startedAt || inicio : inicio;
    return await writeShopifyResetStatus(shop, {
      jobId: `shopify-reset-${agora}`,
      state: "running",
      total: 0,
      processed: 0,
      deleted: retoma ? numero(anterior.deleted) : 0,
      failed: 0,
      revertedLocal: retoma ? numero(anterior.revertedLocal) : 0,
      currentTitle: null,
      error: null,
      startedAt: inicio,
      inicioDoPrimeiroArranque: inicioOriginal,
      finishedAt: null,
      retomadoDe: retoma ? anterior.jobId ?? null : null,
      recentErrors: [],
    });
  } finally {
    await libertarLockDoFicheiro(trinco);
  }
}

/**
 * D39: enquanto o processo vive, o batimento renova o `updatedAt` a cada minuto, mesmo com a Shopify em silêncio (um
 * Retry-After longo). Um reset vivo noutro processo não expira. Morto, o batimento para e o reset expira ao fim de
 * RESET_EXPIRA_MS. Devolve a função que o para.
 * @param {string} shop
 * @param {number} [intervaloMs]
 */
export function iniciarBatimento(shop, intervaloMs = BATIMENTO_MS) {
  const timer = setInterval(() => {
    writeShopifyResetStatus(shop, {}).catch(() => {});
  }, intervaloMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * @param {string} shop
 * @param {Partial<ShopifyResetJobStatus>} progress
 */
export async function updateShopifyResetProgress(shop, progress) {
  return writeShopifyResetStatus(shop, progress);
}

/**
 * @param {string} shop
 * @param {{ deleted: number, failed: number, revertedLocal: number, recentErrors?: object[] }} summary
 */
export async function completeShopifyResetJob(shop, summary) {
  return writeShopifyResetStatus(shop, {
    state: "completed",
    processed: summary.deleted + summary.failed,
    deleted: summary.deleted,
    failed: summary.failed,
    revertedLocal: summary.revertedLocal,
    currentTitle: null,
    finishedAt: new Date().toISOString(),
    recentErrors: summary.recentErrors || [],
  });
}

/**
 * Regista a falha. `extra` leva os contadores e os erros recentes até ao aborto (DBG-30, 2.7 (2)); nunca o `state`.
 * @param {string} shop
 * @param {string} error
 * @param {Partial<ShopifyResetJobStatus>} [extra]
 */
export async function failShopifyResetJob(shop, error, extra = {}) {
  return writeShopifyResetStatus(shop, {
    ...extra,
    state: "failed",
    error: String(error).slice(0, 2000),
    currentTitle: null,
    finishedAt: new Date().toISOString(),
  });
}
