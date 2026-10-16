import fs from "fs/promises";
import path from "path";
import { AsyncLocalStorage } from "node:async_hooks";
import { partitionBulkEligible } from "./bulkEligibility.js";
import { resolveCurationDataDir } from "./dataDir.js";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { evaluateCurationRules } from "../importer/curation/visibilityGatekeeper.js";
import { evaluateSmartRules } from "../importer/curation/smartRules.server.js";
import { assertDbNotDegraded, DbDegradedError, markDbDegraded, readDbDegraded } from "../health/dbDegraded.js";
import prisma from "../../app/db.server.js";
import { evaluateEliteCuration } from "../importer/curation/eliteCuration.server.js";
import { motivoPrecoMinimo } from "../importer/curation/structuredCatalogFilter.server.js";
import { assertApprovable, assertTransitionAllowed } from "./approvalGuard.js";
import { adquirirLockDoFicheiro, CurationQueueLockError, libertarLockDoFicheiro, titularAindaTemLock } from "./curationQueueFileLock.server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Diretório de estado: ver resolveCurationDataDir em dataDir.js (CURATION_DATA_DIR, /app/data, server/data).
const CURATION_DATA_DIR = resolveCurationDataDir();
const QUEUE_PATH = path.join(CURATION_DATA_DIR, "curation-queue.json");
// Lock entre processos (DBG-04, decisão 1 do arquiteto): os scripts que escrevem a fila tomam-no também.
const LOCK_PATH = path.join(CURATION_DATA_DIR, "curation-queue.lock");
const RESULTS_ERRORS_PATH = path.join(process.cwd(), "results", "errors.json");

/** @typedef {'PENDING' | 'APPROVED' | 'REJECTED' | 'PUBLISHED' | 'SYNC_ERROR'} CurationQueueStatus */
/** @typedef {'ACTIVE' | 'DRAFT'} ShopifyQueueStatus */

/**
 * @typedef {object} CurationQueueItem
 * @property {string} sku
 * @property {string} title_en
 * @property {CurationQueueStatus} status
 * @property {string} reason
 * @property {ShopifyQueueStatus} shopifyStatus
 * @property {Record<string, unknown>} metadata
 */

let cachedQueue = null;
let cachedQueueMtime = 0;

export function invalidateCurationMemoryCache() {
  cachedQueue = null;
  cachedQueueMtime = 0;
}

// Serializa todas as operações de load->mutar->save sobre curation-queue.json dentro
// deste processo — sem isto, dois pedidos concorrentes (ex: aprovar manualmente no
// painel enquanto corre uma importação de CSV) podiam carregar antes de qualquer um
// gravar, e o segundo save() apagava silenciosamente as alterações do primeiro a SKUs
// não relacionados (bug encontrado no code review, 2026-08-12). Não protege contra
// múltiplos processos/instâncias a escrever ao mesmo tempo, só contra corridas dentro
// deste processo Node. Entre processos, a mesma serialização faz-se com o lock de ficheiro
// (curationQueueFileLock.server.js), tomado na entrada mais externa (correrComLockDeFicheiro).
// Decisão 35 (D1, D3): o processo principal é o único escritor da fila. O contexto do lock
// marca o código que já corre dentro dele, para que as funções internas não voltem a pedir o
// lock (impasse) e para que nenhuma leitura se junte a uma leitura de fora do lock.
const contextoDoLock = new AsyncLocalStorage();
let queueLock = Promise.resolve();

function dentroDoLock() {
  return contextoDoLock.getStore() !== undefined;
}

/** Só para testes: chama a função a cada aquisição do lock de ficheiro. */
let observadorDeAquisicoes = null;

export function setLockAcquisitionObserverForTests(fn) {
  observadorDeAquisicoes = fn;
}

function withCurationQueueLock(fn) {
  if (dentroDoLock()) return fn();
  const correr = () => correrComLockDeFicheiro(fn);
  const result = queueLock.then(correr, correr);
  queueLock = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * Entrada mais externa do processo: toma o lock de ficheiro (entre processos), corre `fn` no contexto
 * do lock e liberta o ficheiro sempre, mesmo se `fn` falhar. Se o lock não for obtido no prazo, a
 * operação falha antes de tocar na fila (fail closed).
 * @template T
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
async function correrComLockDeFicheiro(fn) {
  const titular = await adquirirLockDoFicheiro(LOCK_PATH);
  observadorDeAquisicoes?.();
  let correu = false;
  try {
    const valor = await contextoDoLock.run({ titular }, fn);
    correu = true;
    return valor;
  } finally {
    // Em qualquer falha da secção, a operação pode ter mudado o objeto da cache antes de a gravação falhar
    // (lock perdido, ENOSPC, rename, exceção depois de mutar). Sem invalidar, leituras de fora do lock
    // veriam estado que o disco não tem. Com sucesso não se invalida: cada escrita reparsearia a fila.
    if (!correu) invalidateCurationMemoryCache();
    await libertarLockDoFicheiro(titular);
  }
}

/**
 * Secção de lote para scripts que escrevem a fila em loop: toma o lock uma vez para `fn`. As
 * escritas feitas dentro de `fn` (approveProduct, markQueueItemDeletedInAdmin, recordLastPriceWrites,
 * ...) reutilizam esse lock. A ordem das escritas não muda. Num processo filho com escritor remoto
 * a fila não se escreve aqui: cada escrita segue por IPC, como antes.
 * @template T
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export function comLockDaFila(fn) {
  if (remoto) return Promise.resolve().then(fn);
  return withCurationQueueLock(fn);
}

/**
 * Aborta antes de tocar no ficheiro quando o titular do lock já o perdeu (a renovação viu outro
 * token). Sem o lock, nada se escreve (fail closed). Fora do lock não há titular e não se verifica.
 */
async function assertTitularAindaValido() {
  const titular = contextoDoLock.getStore()?.titular;
  if (!titular) return;
  if (!titular.perdido && (await titularAindaTemLock(titular))) return;
  console.error("[fila] operação abortada: lock perdido");
  throw new CurationQueueLockError(
    "fila de curadoria: o lock foi perdido a meio da operação; nada foi gravado",
    "CURATION_QUEUE_LOCK_LOST"
  );
}

/**
 * Processo filho com escritor remoto (worker de indexação, harness de teste). Nesse processo a
 * fila nunca é escrita: cada escrita é enviada ao principal por IPC e só volta quando o principal
 * a confirmou (D5). `remoto` é null no processo principal.
 * @type {{ pedir: (operacao: string, argumentos: unknown[]) => Promise<any> } | null}
 */
let remoto = null;

/** Primeira leitura do disco neste processo. Um worker lê uma vez; esta data é o limite conservador de "leitura" (D2). */
let primeiraLeituraDoDisco = 0;

/**
 * @returns {Promise<{ version: number, updatedAt: string | null, items: CurationQueueItem[] }>}
 */
export async function loadCurationQueue() {
  try {
    const stat = await fs.stat(QUEUE_PATH);
    // Dentro do lock lê-se sempre o disco. Outro processo pode ter gravado com o mesmo mtime (o
    // relógio do ficheiro tem granularidade finita), e a cache diria a versão antiga.
    if (dentroDoLock()) return await readAndCacheQueue(stat.mtimeMs);
    if (cachedQueue && stat.mtimeMs === cachedQueueMtime) {
      return cachedQueue;
    }
    // Dentro do lock não se partilha leitura: uma leitura de fora podia estar a meio e ficar presa
    // ao próprio lock (impasse, quando a recuperação da fila precisa de escrever).
    if (inflightLoad && inflightLoad.mtimeMs === stat.mtimeMs) {
      return await inflightLoad.promise;
    }
    // Leituras simultâneas com a cache fria partilham a mesma leitura: cada uma parseava
    // o JSON de ~15 MB por conta própria e o processo morria por falta de memória (OOM em
    // produção, 09/10/2026).
    const promise = readAndCacheQueue(stat.mtimeMs);
    inflightLoad = { mtimeMs: stat.mtimeMs, promise };
    try {
      return await promise;
    } finally {
      if (inflightLoad?.promise === promise) inflightLoad = null;
    }
  } catch (err) {
    if (err?.code === "ENOENT") {
      await assertMissingQueueIsFirstStart();
      return { version: 1, updatedAt: null, items: [] };
    }
    throw err;
  }
}

/** @type {{ mtimeMs: number, promise: Promise<any> }|null} */
let inflightLoad = null;

/**
 * Leitura do número de produtos do catálogo. Trocável só em testes (ver setCatalogCountReaderForTests).
 * @type {() => Promise<number>}
 */
let catalogCountReader = () => prisma.catalogProduct.count();

/** Só para testes: troca a leitura do número de produtos do catálogo. */
export function setCatalogCountReaderForTests(fn) {
  catalogCountReader = fn;
}

/**
 * Fila em falta (revisão do Lote 1, ponto 4). Vazia só é aceite no primeiro arranque sem catálogo.
 * Com backup de corrupção no volume ou com produtos no catálogo, grava a flag DB_DEGRADED e
 * recusa a leitura. Se não der para saber se há catálogo, recusa sem gravar a flag.
 */
async function assertMissingQueueIsFirstStart() {
  const degraded = readDbDegraded();
  if (degraded) throw new DbDegradedError("leitura da fila de curadoria", degraded);

  const entries = await fs.readdir(CURATION_DATA_DIR).catch(() => []);
  const backups = entries.filter((f) => f.startsWith("curation-queue.json.corrupt"));
  if (backups.length) {
    await degradeMissingQueue(`fila de curadoria em falta, com backup de corrupção no volume (${backups.length})`);
  }

  let total;
  try {
    total = await catalogCountReader();
  } catch (err) {
    throw new Error(
      `fila de curadoria em falta e não foi possível confirmar se há catálogo na BD (${err?.message || err}). Leitura recusada.`
    );
  }
  if (total > 0) {
    await degradeMissingQueue(`fila de curadoria em falta, com catálogo populado (${total} produto(s))`);
  }

  // Último passo: se o ficheiro apareceu durante as leituras, não se devolve fila vazia. Um escritor
  // gravaria essa fila vazia por cima do ficheiro que apareceu. Recusa e a próxima leitura lê o ficheiro.
  if (await queueFileExists()) throw queueReappearedError();
}

/**
 * Grava a flag e lança, salvo se o ficheiro apareceu entretanto (então recusa sem flag).
 * @param {string} cause
 */
async function degradeMissingQueue(cause) {
  if (await queueFileExists()) throw queueReappearedError();
  markDbDegraded(cause);
  throw new DbDegradedError("leitura da fila de curadoria", readDbDegraded());
}

function queueReappearedError() {
  return new Error("fila de curadoria apareceu durante a leitura. Repetir a operação; nada foi gravado.");
}

/** @returns {Promise<boolean>} */
function queueFileExists() {
  return fs.access(QUEUE_PATH).then(
    () => true,
    () => false
  );
}

/**
 * Fila em memória mesmo que o ficheiro tenha mudado entretanto; só lê do disco se não
 * houver nenhuma. Para leituras que toleram uma cópia um pouco antiga — a margem por
 * produto no painel: durante a indexação o worker regrava o ficheiro a cada flush, e
 * reler 15 MB a cada pesquisa punha cada pedido nos ~2 s (09/10/2026). Os overrides só
 * mudam neste processo (bulkSetMarginPct/setManualOverride → save → cache limpa), e o
 * worker preserva-os, por isso a cópia em memória tem-nos sempre certos.
 */
export async function loadCurationQueueCached() {
  return cachedQueue || loadCurationQueue();
}

/**
 * Leitura para o painel (DBG-22). Fila degradada não derruba o loader: devolve fila vazia e a
 * causa em `blocked`, e o banner (app.jsx) mostra o motivo. Qualquer outro erro sobe.
 * @returns {Promise<{ queue: { version: number, updatedAt: string | null, items: CurationQueueItem[] }, blocked: string | null }>}
 */
export async function loadCurationQueueForPanel() {
  try {
    return { queue: await loadCurationQueue(), blocked: null };
  } catch (err) {
    if (err?.code !== "DB_DEGRADED") throw err;
    return { queue: { version: 1, updatedAt: null, items: [] }, blocked: err.message };
  }
}

async function readAndCacheQueue(mtimeMs) {
  const iniciadoEm = Date.now();
  const raw = await fs.readFile(QUEUE_PATH, "utf8");
  if (!primeiraLeituraDoDisco) primeiraLeituraDoDisco = iniciadoEm;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (parseErr) {
    const recovered = await recoverCorruptedQueueJson(raw, parseErr);
    if (!recovered) {
      // Lança sempre: nunca continua com fila vazia (DBG-22).
      await degradeUnrecoverableQueue(raw, parseErr);
    }
    parsed = recovered;
  }
  const result = {
    version: parsed.version ?? 1,
    updatedAt: parsed.updatedAt ?? null,
    items: Array.isArray(parsed.items) ? parsed.items : [],
  };
  cachedQueue = result;
  cachedQueueMtime = mtimeMs;
  return result;
}

/**
 * Tenta recuperar `curation-queue.json` quando há caracteres inválidos em JSON.
 * Estratégia: backup do ficheiro original, sanitização de control chars e persistência do conteúdo recuperado.
 * @param {string} raw
 * @param {unknown} parseErr
 * @returns {Promise<{ version?: number, updatedAt?: string | null, items?: unknown[] } | null>}
 */
async function recoverCorruptedQueueJson(raw, parseErr) {
  // Os backups e a recuperação escrevem na fila: bloqueados em modo degradado (Decisão 34).
  assertDbNotDegraded("recuperação da fila de curadoria");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${QUEUE_PATH}.corrupt-${timestamp}.json`;
  const sanitized = String(raw).replace(/[\u0000-\u001F]/g, "");

  if (sanitized === raw) {
    await logQueueRepairError("parse_failed_no_sanitization_change", parseErr, { backupPath: null });
    return null;
  }

  try {
    await fs.mkdir(path.dirname(QUEUE_PATH), { recursive: true });
    await fs.writeFile(backupPath, raw, "utf8");

    const parsed = JSON.parse(sanitized);
    const recovered = {
      version: parsed?.version ?? 1,
      updatedAt: parsed?.updatedAt ?? null,
      items: Array.isArray(parsed?.items) ? parsed.items : [],
    };

    if (!remoto) await reparaFilaRecuperada(raw, recovered);
    await logQueueRepairError("recovered_by_sanitization", parseErr, {
      backupPath,
      itemsRecovered: recovered.items.length,
    });
    return recovered;
  } catch (recoveryErr) {
    await logQueueRepairError("recovery_failed", recoveryErr, { backupPath });
    return null;
  }
}

/**
 * DBG-22 (Lote 1, Decisão 34): fila que não recupera não é reiniciada em silêncio. Guarda o
 * ficheiro original em backup, grava a flag DB_DEGRADED com a causa e recusa a leitura. O banner
 * aparece no painel e nenhuma escrita corre sobre uma fila vazia. O ficheiro corrompido não é tocado.
 * @param {string} raw
 * @param {unknown} parseErr
 * @returns {Promise<never>}
 */
async function degradeUnrecoverableQueue(raw, parseErr) {
  assertDbNotDegraded("leitura da fila de curadoria");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${QUEUE_PATH}.corrupt-${timestamp}.json`;
  await fs.mkdir(path.dirname(QUEUE_PATH), { recursive: true });
  await fs.writeFile(backupPath, raw, "utf8");
  markDbDegraded(`fila de curadoria corrompida e não recuperável (backup: ${path.basename(backupPath)})`);
  await logQueueRepairError("queue_unrecoverable_degraded", parseErr, {
    backupPath,
    itemsRecovered: 0,
  });
  throw new DbDegradedError("leitura da fila de curadoria", readDbDegraded());
}

/**
 * Regista erros de recuperação da fila em results/errors.json.
 * @param {string} code
 * @param {unknown} error
 * @param {Record<string, unknown>} [context]
 */
async function logQueueRepairError(code, error, context = {}) {
  const entry = {
    operacao: "curationQueue.load",
    codigo: code,
    mensagem: error instanceof Error ? error.message : String(error),
    timestamp: new Date().toISOString(),
    contexto: context,
  };

  try {
    await fs.mkdir(path.dirname(RESULTS_ERRORS_PATH), { recursive: true });
    let list = [];
    try {
      const raw = await fs.readFile(RESULTS_ERRORS_PATH, "utf8");
      const parsed = JSON.parse(raw);
      list = Array.isArray(parsed) ? parsed : [];
    } catch {
      list = [];
    }
    list.push(entry);
    await fs.writeFile(RESULTS_ERRORS_PATH, JSON.stringify(list, null, 2), "utf8");
  } catch {
    // Nunca falhar o fluxo principal por erro de logging.
  }
}

/** Escrita fora do processo principal: a fila não se escreve daqui (Decisão 35, D1). */
function recusarSeRemoto(operacao) {
  if (remoto) {
    throw new Error(`${operacao}: a fila só é escrita pelo processo principal (Decisão 35)`);
  }
}

/**
 * Recuperação de JSON corrompido: repõe o ficheiro sanitizado, mas só se o ficheiro ainda for o
 * que foi lido. Dentro do lock grava já; fora, espera pelo lock (sem impasse: a leitura pública
 * nunca segura o lock).
 * @param {string} raw
 * @param {{ version: number, updatedAt: string | null, items: unknown[] }} recovered
 */
async function reparaFilaRecuperada(raw, recovered) {
  const reparar = async () => {
    const atual = await fs.readFile(QUEUE_PATH, "utf8").catch(() => null);
    if (atual !== raw) return;
    await escreverFila(recovered);
  };
  return dentroDoLock() ? reparar() : withCurationQueueLock(reparar);
}

/**
 * Escrita da fila sem lock próprio. Quem chama tem de estar dentro do lock (funções *Locked) ou ter a
 * fila só para si (preparação em testes). Com lock próprio, a janela entre a leitura e a escrita de
 * uma função locked deixava de estar protegida (Decisão 35, D1).
 * @param {{ version?: number, updatedAt?: string | null, items: CurationQueueItem[] }} queue
 */
export async function saveCurationQueue(queue) {
  recusarSeRemoto("saveCurationQueue");
  return escreverFila(queue);
}

/**
 * Escrita física e atómica (tmp + rename). Chamar só dentro do lock.
 * @param {{ version?: number, updatedAt?: string | null, items: CurationQueueItem[] }} queue
 */
async function escreverFila(queue) {
  // Modo degradado (Decisão 34): nenhuma escrita na fila enquanto a BD estiver degradada.
  assertDbNotDegraded("escrita na fila de curadoria");
  await fs.mkdir(path.dirname(QUEUE_PATH), { recursive: true });
  const payload = {
    version: queue.version ?? 1,
    updatedAt: new Date().toISOString(),
    items: queue.items,
  };
  await assertTitularAindaValido();
  const tmp = `${QUEUE_PATH}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  // Sem indentação: só um ficheiro de estado interno (nunca lido/editado por humanos),
  // e o JSON.stringify síncrono bloqueia o event loop — medido em produção (29.601
  // itens): ~249ms com indent:2 vs bem menos compacto. Ver relatório de performance.
  await fs.writeFile(tmp, JSON.stringify(payload), "utf8");
  try {
    await assertTitularAindaValido();
    await fs.rename(tmp, QUEUE_PATH);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
  invalidateCurationMemoryCache();
  return payload;
}

/**
 * Grava em disco um subconjunto de itens (novos ou atualizados), fazendo upsert
 * por SKU sobre o que já está persistido — em vez de reescrever a partir de um
 * array completo em memória. Usado pelo streaming de indexação para libertar os
 * objetos da queue após cada flush periódico, sem perder o que já foi gravado
 * em flushes anteriores.
 * @param {CurationQueueItem[]} items
 */
export async function flushCurationQueueItems(items, opts = {}) {
  // Leitura de referência: quando o worker leu a fila pela primeira vez. Tudo o que o worker
  // calcula parte dessa leitura; uma decisão humana posterior ganha (D2).
  const lidoEm = opts.readAt ?? primeiraLeituraDoDisco;
  if (remoto) {
    // D1: lotes de até 250 itens por mensagem. Cada lote só avança quando o principal confirma (D5).
    for (let i = 0; i < (items?.length || 0); i += TAMANHO_LOTE_IPC) {
      await remoto.pedir("flushCurationQueueItems", [items.slice(i, i + TAMANHO_LOTE_IPC), { readAt: lidoEm }]);
    }
    return;
  }
  return withCurationQueueLock(() => flushCurationQueueItemsLocked(items, lidoEm));
}

/** Itens por mensagem IPC (Decisão 35, D1). Medir em R4: cada lote gera uma escrita do ficheiro. */
const TAMANHO_LOTE_IPC = 250;

/**
 * Estados que o worker não altera (D6, Confirmação 1 do arquiteto). PUBLISHED e SYNC_ERROR ficam
 * sempre congelados. APPROVED e REJECTED só o ficam quando a decisão é humana (fixadoPorDecisaoHumana);
 * os de regra ou de elite recalculam-se.
 */
const ESTADOS_QUE_O_WORKER_NAO_ALTERA = new Set(["PUBLISHED", "SYNC_ERROR"]);

/** Campos que só o disco (publicação, overrides, reset) escreve. O worker não os repõe. */
const CAMPOS_DO_DISCO = [
  "overrides",
  "overridesUpdatedAt",
  "lastPriceWrite",
  "shopifyProductId",
  "publishedAt",
  "costAtPublish",
  "syncError",
  "syncErrorAt",
  "deletedInAdmin",
  "wasPublished",
  // Decisão 2 (DBG-04): alerta de produto criado na Shopify depois de uma decisão humana. Só o disco o escreve,
  // e o worker não o pode apagar nem num item rejeitado por regra (origem diferente de humano).
  "alertaPublicadoNaShopify",
  "shopifyResetAt",
  "lastElitePurgeAt",
];

/** Campos de estado calculados pelas regras. Só se aplicam quando o worker pode alterar o estado. `origem` (D6) diz que a decisão veio de regra de painel. */
const CAMPOS_DE_ESTADO = ["approvedAt", "rejectedAt", "smartRule", "smartAction", "smartRuleId", "origem", "eliteCuration", "eliteAction", "aiCuration"];

/** @param {Record<string, unknown>} obj @param {string[]} campos */
function semCampos(obj, campos) {
  const copia = { ...obj };
  for (const campo of campos) delete copia[campo];
  return copia;
}

/** @param {Record<string, unknown>} obj @param {string[]} campos */
function soCampos(obj, campos) {
  const resultado = {};
  for (const campo of campos) if (campo in obj) resultado[campo] = obj[campo];
  return resultado;
}

/**
 * Funde um item calculado pelo worker sobre o item atual do disco (D1, D2, D6).
 * - Estado fixado por decisão humana (ver fixadoPorDecisaoHumana) ou decisão humana gravada depois da
 *   leitura do worker (statusChangedAt >= lidoEm): mantém status, shopifyStatus e razão.
 * - Campos do disco (overrides, lastPriceWrite, shopifyProductId, ...) são sempre os do disco.
 * - O resto (título e metadados de origem) vem do worker.
 * @param {CurationQueueItem} atual
 * @param {CurationQueueItem} recebido
 * @param {number} lidoEm
 * @returns {CurationQueueItem}
 */
function fundirItemDoWorker(atual, recebido, lidoEm) {
  const quando = Date.parse(atual.statusChangedAt);
  const decisaoHumanaDepois = Number.isFinite(quando) && quando >= lidoEm;
  const protegido = fixadoPorDecisaoHumana(atual) || decisaoHumanaDepois;
  const metaDisco = atual.metadata || {};
  const metaWorker = recebido.metadata || {};
  const metadata = protegido
    ? { ...metaDisco, ...semCampos(metaWorker, [...CAMPOS_DO_DISCO, ...CAMPOS_DE_ESTADO]) }
    : { ...semCampos(metaWorker, CAMPOS_DO_DISCO), ...soCampos(metaDisco, CAMPOS_DO_DISCO) };
  const fundido = { ...atual, title_en: recebido.title_en ?? atual.title_en, metadata };
  if (!protegido) {
    fundido.status = recebido.status;
    fundido.reason = recebido.reason;
    fundido.shopifyStatus = recebido.shopifyStatus;
  }
  return fundido;
}

/**
 * @param {CurationQueueItem[]} items
 * @param {number} lidoEm
 */
async function flushCurationQueueItemsLocked(items, lidoEm) {
  if (!items?.length) return;
  const onDisk = await loadCurationQueue();
  const bySku = new Map(onDisk.items.map((item) => [item.sku, item]));
  for (const recebido of items) {
    const atual = bySku.get(recebido.sku);
    bySku.set(recebido.sku, atual ? fundirItemDoWorker(atual, recebido, lidoEm) : recebido);
  }
  await escreverFila({ version: onDisk.version ?? 1, items: Array.from(bySku.values()) });
}

/**
 * @param {string} sku
 */
// Índice sku->item por objeto de queue (WeakMap, invalida sozinho quando
// loadCurationQueue() devolve um objeto novo após reload/save) — evita repetir um
// Array.find() em ~30k itens a cada chamada de getCurationQueueEntry(), que agora é
// invocado uma vez por produto em cada publish (achado de eficiência no code review,
// 2026-08-12).
const queueIndexBySkuCache = new WeakMap();

function getQueueIndexBySku(queue) {
  let index = queueIndexBySkuCache.get(queue);
  if (!index) {
    index = new Map(queue.items.map((item) => [item.sku, item]));
    queueIndexBySkuCache.set(queue, index);
  }
  return index;
}

export async function getCurationQueueEntry(sku) {
  const queue = await loadCurationQueue();
  return getQueueIndexBySku(queue).get(sku) ?? null;
}

function snapshotQueueItem(item) {
  if (!item) return null;
  return {
    sku: item.sku,
    status: item.status,
    shopifyStatus: item.shopifyStatus,
    metadata: { ...(item.metadata || {}) },
  };
}

/**
 * @param {CurationQueueStatus} [status]
 */
export async function listCurationQueueItems(status) {
  const queue = await loadCurationQueue();
  if (!status) return queue.items;
  return queue.items.filter((item) => item.status === status);
}

/**
 * Produtos à espera de decisão humana (base da UI de curadoria).
 */
export async function listPendingProducts() {
  return listCurationQueueItems("PENDING");
}

/**
 * Grava a entrada do produto na fila e devolve a entrada gravada (DBG-50).
 * @param {import('../importer/types.js').ProductRecord} record
 * @returns {Promise<CurationQueueItem>}
 */
export async function upsertCurationQueueFromRecord(record) {
  // Devolve só a entrada gravada (um item), não a fila: o payload inteiro (~15 MB) não segue por IPC.
  return escrever("upsertCurationQueueFromRecord", [record], () =>
    withCurationQueueLock(() => upsertCurationQueueFromRecordLocked(record))
  );
}

/**
 * Item apagado no admin que voltou a PENDING (markQueueItemDeletedInAdmin). O reindex do
 * feed recalcula todos os PENDING pelas regras automáticas, o que (a) apagava a nota, a
 * data e o selo «Já esteve publicado» e (b) deixava uma regra AUTO_APPROVE devolvê-lo sozinho
 * a APPROVED — e o publisher recriava um produto que o Carlos apagou. Decisão de 09/10/2026:
 * só a aprovação nova do Carlos o tira de PENDING. Tratado como decisão manual no reindex.
 * @param {{ status?: string, metadata?: { deletedInAdmin?: unknown } }} item
 */
function isHeldAfterDeletion(item) {
  return item?.status === "PENDING" && Boolean(item?.metadata?.deletedInAdmin);
}

/**
 * Origem explícita gravada em `metadata.origem`, ou null se não houver uma válida.
 * @param {Record<string, any> | null | undefined} meta
 * @returns {'humano' | 'regra' | 'elite' | 'reset' | null}
 */
function origemExplicita(meta) {
  const origem = meta?.origem;
  return origem === "humano" || origem === "regra" || origem === "elite" || origem === "reset" ? origem : null;
}

/**
 * Origens que congelam o item como decisão humana: a decisão do Carlos e o reset (Decisão 5, regra de 09/10).
 * Um item com uma destas origens fica fora das regras de painel e da elite, no reindex e no flush do worker,
 * até uma decisão humana nova. A origem reset não se recalcula.
 * @param {string | null | undefined} origem
 */
function origemCongelada(origem) {
  return origem === "humano" || origem === "reset";
}

/**
 * Origem inferida de um item sem `origem` explícita (Decisão 5, sem migração). Regra só quando o estado
 * bate com smartAction: AUTO_APPROVE com APPROVED, AUTO_REJECT com REJECTED. Elite quando eliteAction é
 * AUTO_REJECT e o estado é REJECTED. Caso contrário, humano.
 * @param {string | undefined} status
 * @param {Record<string, any> | null | undefined} meta
 * @returns {'humano' | 'regra' | 'elite'}
 */
function origemInferida(status, meta) {
  if (meta?.eliteAction === "AUTO_REJECT" && status === "REJECTED") return "elite";
  if (meta?.smartAction === "AUTO_APPROVE" && status === "APPROVED") return "regra";
  if (meta?.smartAction === "AUTO_REJECT" && status === "REJECTED") return "regra";
  return "humano";
}

/**
 * Origem de uma decisão APPROVED ou REJECTED (Decisões 4 e 5). `humano` fica como está. `regra` e `elite`
 * recalculam-se pelas regras atuais. A origem explícita manda. Um item sem origem explícita é legado:
 * o statusChangedAt (marca de decisão humana do D2) decide humano, e sem ele a origem infere-se do estado
 * e das marcas de regra ou de elite.
 * @param {{ status?: string, statusChangedAt?: string | null, metadata?: Record<string, any> } | null | undefined} item
 * @returns {'humano' | 'regra' | 'elite' | 'reset'}
 */
function origemDaDecisao(item) {
  const explicita = origemExplicita(item?.metadata);
  if (explicita) return explicita;
  if (item?.statusChangedAt) return "humano";
  return origemInferida(item?.status, item?.metadata);
}

/**
 * Item que nem as regras nem o worker mudam (Decisão 35, D2, D29, regra de 09/10): PUBLISHED, SYNC_ERROR,
 * apagado no admin retido, PENDING com decisão humana (statusChangedAt, fora das regras) e APPROVED ou
 * REJECTED de decisão humana. APPROVED e REJECTED de regra ou de elite não entram aqui.
 * @param {CurationQueueItem | null | undefined} item
 */
function fixadoPorDecisaoHumana(item) {
  if (!item) return false;
  if (ESTADOS_QUE_O_WORKER_NAO_ALTERA.has(item.status) || isHeldAfterDeletion(item)) return true;
  // Decisão 5: um PENDING devolvido pelo reset (origem reset) fica fixado mesmo sem statusChangedAt.
  if (item.status === "PENDING") {
    const origem = origemExplicita(item.metadata);
    return Boolean(item.statusChangedAt) || (origem === "reset" && origemCongelada(origem));
  }
  if (item.status === "APPROVED" || item.status === "REJECTED") return origemCongelada(origemDaDecisao(item));
  return false;
}

/**
 * Regra de painel (D6, Decisão 3 do arquiteto, Confirmação 1). Age sobre item novo, sobre PENDING e sobre
 * APPROVED ou REJECTED de regra ou de elite, que se recalculam quando a regra muda. Nunca age sobre
 * APPROVED ou REJECTED de decisão humana. Um PENDING com decisão humana (statusChangedAt) também passa aqui
 * como verdadeiro: quem o protege é fixadoPorDecisaoHumana, que os dois chamadores consultam antes de usar
 * o resultado da regra (Decisão 7).
 * @param {{ status?: string, statusChangedAt?: string | null, metadata?: Record<string, any> } | null | undefined} existente
 */
function regraDePainelPodeAgir(existente) {
  if (!existente || existente.status === "PENDING") return true;
  if (existente.status === "APPROVED" || existente.status === "REJECTED") return !origemCongelada(origemDaDecisao(existente));
  return false;
}

/** Resultado de evaluateSmartRules quando a regra de painel não age sobre o item (D6). */
const SEM_REGRA_DE_PAINEL = Object.freeze({ action: null, rule: null, reasons: [] });

/**
 * @param {import('../importer/types.js').ProductRecord} record
 */
async function upsertCurationQueueFromRecordLocked(record) {
  const queue = await loadCurationQueue();
  const idx = queue.items.findIndex((item) => item.sku === record.sku);
  const elite = evaluateEliteCuration(record);
  // Decisão 4: o portão de preço mínimo impede que uma regra AUTO_APPROVE aprove abaixo do mínimo (ver o ramo de
  // regra abaixo). Não rejeita: o item fica PENDING, para decisão manual.
  const precoMinimo = motivoPrecoMinimo(record);
  // D6: a regra de painel só conta para item novo ou PENDING sem decisão humana.
  const regraAtiva = regraDePainelPodeAgir(idx >= 0 ? queue.items[idx] : null);
  const regra = regraAtiva ? evaluateSmartRules(record) : SEM_REGRA_DE_PAINEL;
  const { reasons: gateReasons } = evaluateCurationRules(record);

  const titleEn =
    record._translated?.title || record.title || record._source?.title || "";
  const titleEs = record._source?.title || record.title || "";

  let queueStatus = "PENDING";
  // Um PENDING nunca fica ACTIVE nem com reason approved. O default é DRAFT e pending.
  let shopifyStatus = "DRAFT";
  let primaryReason = "pending";
  /** @type {Record<string, unknown>} */
  let metaExtras = {};

  if (elite.action === "AUTO_REJECT") {
    queueStatus = "REJECTED";
    shopifyStatus = "DRAFT";
    primaryReason = elite.reasons[0] || "elite_auto_reject";
    metaExtras = {
      eliteCuration: true,
      eliteAction: "AUTO_REJECT",
      origem: "elite",
      rejectedAt: new Date().toISOString(),
      approvedAt: null,
    };
  } else if (elite.action === "PENDING_MANUAL") {
    queueStatus = "PENDING";
    shopifyStatus = "DRAFT";
    primaryReason = elite.reasons[0] || "elite_brand_not_premium";
    metaExtras = {
      eliteCuration: true,
      eliteAction: "PENDING_MANUAL",
      approvedAt: null,
      rejectedAt: null,
    };
  } else if (regra.action === "AUTO_APPROVE" && !precoMinimo) {
    // Decisão 4: abaixo do mínimo, a regra não aprova. Cai no PENDING final, sem origem regra e sem approvedAt.
    queueStatus = "APPROVED";
    shopifyStatus = "ACTIVE";
    primaryReason = regra.reasons[0] || "smart_auto_approve";
    metaExtras = {
      smartRule: true,
      smartAction: "AUTO_APPROVE",
      smartRuleId: regra.rule?.id || null,
      origem: "regra",
      approvedAt: new Date().toISOString(),
      rejectedAt: null,
    };
  } else if (regra.action === "AUTO_REJECT") {
    queueStatus = "REJECTED";
    shopifyStatus = "DRAFT";
    primaryReason = regra.reasons[0] || "smart_auto_reject";
    metaExtras = {
      smartRule: true,
      smartAction: "AUTO_REJECT",
      smartRuleId: regra.rule?.id || null,
      origem: "regra",
      rejectedAt: new Date().toISOString(),
      approvedAt: null,
    };
  }

  // Briefing 16/09/2026 — os ramos "record._aiCuration === APPROVE/REJECT" saíram
  // daqui. A curadoria por Gemini decidia sozinha (aprovava ou rejeitava sem o Carlos
  // ver) e, pior, um produto por ela aprovado NÃO contava como decisão manual para o
  // `isManual` abaixo — ficava sujeito a reavaliação livre em todo reindex. Se a chave
  // fosse retirada antes da chamada, o próximo reindex devolvia PENDING e o produto
  // caía de APPROVED/ACTIVE para PENDING silenciosamente, sem erro no log. A regra que
  // fica: a aprovação do Carlos no painel é a decisão final — nada a jusante aprova ou
  // recusa por conta própria; se algo tiver de travar um produto depois da aprovação,
  // falha com erro visível.

  if (idx >= 0) {
    const existing = queue.items[idx];
    // Tarefa 53 (Decisão 29, 2026-09-13) — SYNC_ERROR é estado TERMINAL que exige
    // juízo humano, incondicionalmente — ao contrário de APPROVED/REJECTED/PUBLISHED
    // (que um reindex pode reavaliar quando a decisão original também foi automática,
    // via smartRule/aiCuration/eliteCuration), um SYNC_ERROR nunca é "reavaliação
    // livre": o facto de ter acabado de falhar a publicar é informação nova que exige
    // revisão humana, seja qual for a origem da aprovação anterior. Sem esta exceção
    // incondicional, um reindex do feed (relógio de 45 min) recalcula o produto pelas
    // regras automáticas e pode devolvê-lo sozinho a APPROVED — o erro de publicação
    // desaparece do radar sem ninguém o ter visto, e o produto republica na corrida
    // seguinte como se nada tivesse falhado. Aconteceu ao vivo no lote piloto v4: 5 de
    // 6 SYNC_ERROR viraram APPROVED entre a paragem e o retry, por esta via, não por
    // ação humana. Só transição manual (setManualOverride, approveProduct,
    // bulkSetQueueStatus) tira um SKU daqui — o reindex nunca mais.
    // Lote 1 (revisão, ponto 2): PUBLISHED nunca é reavaliado pelo reindex, como já acontecia no
    // lote. Antes só o era sem metadata de regra, e um reindex podia devolvê-lo a APPROVED.
    // Confirmação 1: só o que está fixado por decisão humana fica como está. APPROVED e REJECTED de regra
    // ou de elite recalculam-se; a regra de painel já vê regraAtiva a true para eles.
    const isManual = fixadoPorDecisaoHumana(existing);

    if (isManual) {
      existing.title_en = titleEn;
      existing.metadata = {
        ...existing.metadata,
        ...buildMetadata(record, gateReasons, titleEs),
        lastSeenAt: new Date().toISOString(),
      };
    } else {
      existing.title_en = titleEn;
      existing.reason = primaryReason;
      existing.shopifyStatus = shopifyStatus;
      existing.status = queueStatus;
      existing.metadata = {
        ...buildMetadata(record, [...elite.reasons, ...regra.reasons, ...gateReasons], titleEs),
        // Overrides manuais (setManualOverride, item 9) não vêm de buildMetadata() —
        // sem isto, um reindex apaga silenciosamente qualquer título/preço/categoria
        // editado à mão via re-import de CSV (bug encontrado no code review, 2026-08-12).
        ...(existing.metadata?.overrides ? { overrides: existing.metadata.overrides, overridesUpdatedAt: existing.metadata.overridesUpdatedAt } : {}),
        ...(existing.metadata?.lastPriceWrite ? { lastPriceWrite: existing.metadata.lastPriceWrite } : {}),
        ...(existing.metadata?.deletedInAdmin ? { deletedInAdmin: existing.metadata.deletedInAdmin, wasPublished: true } : {}),
        ...(existing.metadata?.alertaPublicadoNaShopify ? { alertaPublicadoNaShopify: existing.metadata.alertaPublicadoNaShopify } : {}),
        // C12: campos que só o disco escreve (publicação, reset, erro de sincronização) são sempre os do disco,
        // também num item de regra não fixado. É a mesma regra do caminho do worker (fundirItemDoWorker).
        ...soCampos(existing.metadata || {}, CAMPOS_DO_DISCO),
        ...metaExtras,
      };
    }
  } else {
    queue.items.push({
      sku: record.sku,
      title_en: titleEn,
      status: queueStatus,
      reason: primaryReason,
      shopifyStatus,
      metadata: {
        ...buildMetadata(record, [...elite.reasons, ...regra.reasons, ...gateReasons], titleEs),
        ...metaExtras,
      },
    });
  }

  // DBG-50: devolve a entrada gravada (não o payload). O importador usa-a para decidir o
  // estado Shopify sem depender da cache de 2 s do gatekeeper, que não vê esta escrita.
  const entradaGravada = idx >= 0 ? queue.items[idx] : queue.items[queue.items.length - 1];
  await saveCurationQueue(queue);
  return entradaGravada;
}

// NOTA: esta função não está protegida por withCurationQueueLock de propósito — o
// único caller real (catalogProductsDb.server.js -> syncCatalogWithProgress.server.js)
// chama sempre com { queue: externalQueue, saveFile: false }: o load/save real é feito
// por loadCurationQueue() uma vez no início da reindexação inteira e por
// flushCurationQueueItems() (essa sim, protegida) nos flushes periódicos. Bloquear aqui
// serializaria as ~30k chamadas por reindexação sem proteger o ficheiro em disco, que
// é gerido noutro sítio.
export async function upsertCurationQueueBatchFromRecords(records = [], options = {}) {
  if (!records.length) return;
  const { queue: externalQueue, saveFile = true } = options;
  if (saveFile && !externalQueue) {
    // D1, D3: a gravação do lote faz-se dentro do lock, sobre a fila lida de novo.
    return escrever("upsertCurationQueueBatchFromRecords", [records, { saveFile: true }], () =>
      mutateCurationQueue((fila) => {
        aplicarLoteNaFila(fila, records);
        return { gravar: true, valor: undefined };
      })
    );
  }
  const queue = externalQueue || (await loadCurationQueue());
  aplicarLoteNaFila(queue, records);
  return queue;
}

/**
 * Aplica um lote de registos sobre a fila em memória. Não grava.
 * @param {{ items: CurationQueueItem[], version?: number, _bySku?: Map<string, { item: CurationQueueItem, index: number }> }} queue
 * @param {any[]} records
 */
function aplicarLoteNaFila(queue, records) {
  
  if (!queue._bySku) {
    const bySku = new Map();
    for (let i = 0; i < queue.items.length; i++) {
      bySku.set(queue.items[i].sku, { item: queue.items[i], index: i });
    }
    queue._bySku = bySku;
  }
  const bySku = queue._bySku;

  for (const record of records) {
    if (!record?.sku) continue;
    const existingEntry = bySku.get(record.sku);
    const elite = evaluateEliteCuration(record);
    // Decisão 4: o portão de preço mínimo impede que uma regra AUTO_APPROVE aprove abaixo do mínimo (ver o ramo de
    // regra abaixo). Não rejeita: o item fica PENDING, para decisão manual.
    const precoMinimo = motivoPrecoMinimo(record);
    // D6: a regra de painel só conta para item novo ou PENDING sem decisão humana.
    const regra = regraDePainelPodeAgir(existingEntry?.item) ? evaluateSmartRules(record) : SEM_REGRA_DE_PAINEL;
    const { reasons: gateReasons } = evaluateCurationRules(record);

    const titleEn = record._translated?.title || record.title || record._source?.title || "";
    const titleEs = record._source?.title || record.title || "";

    let queueStatus = "PENDING";
    // Um PENDING nunca fica ACTIVE nem com reason approved. O default é DRAFT e pending.
    let shopifyStatus = "DRAFT";
    let primaryReason = "pending";
    let metaExtras = {};

    if (elite.action === "AUTO_REJECT") {
      queueStatus = "REJECTED";
      shopifyStatus = "DRAFT";
      primaryReason = elite.reasons[0] || "elite_auto_reject";
      metaExtras = { eliteCuration: true, eliteAction: "AUTO_REJECT", origem: "elite", rejectedAt: new Date().toISOString(), approvedAt: null };
    } else if (elite.action === "PENDING_MANUAL") {
      queueStatus = "PENDING";
      shopifyStatus = "DRAFT";
      primaryReason = elite.reasons[0] || "elite_brand_not_premium";
      metaExtras = { eliteCuration: true, eliteAction: "PENDING_MANUAL", approvedAt: null, rejectedAt: null };
    } else if (regra.action === "AUTO_APPROVE" && !precoMinimo) {
      // Decisão 4: abaixo do mínimo, a regra não aprova. Cai no PENDING final, sem origem regra e sem approvedAt.
      queueStatus = "APPROVED";
      shopifyStatus = "ACTIVE";
      primaryReason = regra.reasons[0] || "smart_auto_approve";
      metaExtras = { smartRule: true, smartAction: "AUTO_APPROVE", origem: "regra", approvedAt: new Date().toISOString(), rejectedAt: null };
    } else if (regra.action === "AUTO_REJECT") {
      queueStatus = "REJECTED";
      shopifyStatus = "DRAFT";
      primaryReason = regra.reasons[0] || "smart_auto_reject";
      metaExtras = { smartRule: true, smartAction: "AUTO_REJECT", origem: "regra", rejectedAt: new Date().toISOString(), approvedAt: null };
    }

    if (existingEntry) {
      const existing = existingEntry.item;
      // D29 (caminho em lote): SYNC_ERROR protegido incondicionalmente, como no caminho único. Confirmação 1:
      // APPROVED e REJECTED só ficam se a decisão for humana.
      if (fixadoPorDecisaoHumana(existing)) {
        existing.title_en = titleEn;
        existing.metadata = { ...existing.metadata, ...buildMetadata(record, gateReasons, titleEs), lastSeenAt: new Date().toISOString() };
      } else {
        existing.title_en = titleEn;
        existing.reason = primaryReason;
        existing.shopifyStatus = shopifyStatus;
        existing.status = queueStatus;
        existing.metadata = {
          ...buildMetadata(record, [...elite.reasons, ...regra.reasons, ...gateReasons], titleEs),
          ...(existing.metadata?.overrides ? { overrides: existing.metadata.overrides, overridesUpdatedAt: existing.metadata.overridesUpdatedAt } : {}),
          ...(existing.metadata?.lastPriceWrite ? { lastPriceWrite: existing.metadata.lastPriceWrite } : {}),
          ...(existing.metadata?.deletedInAdmin ? { deletedInAdmin: existing.metadata.deletedInAdmin, wasPublished: true } : {}),
          ...(existing.metadata?.alertaPublicadoNaShopify ? { alertaPublicadoNaShopify: existing.metadata.alertaPublicadoNaShopify } : {}),
          ...metaExtras,
        };
      }
    } else {
      const newItem = {
        sku: record.sku,
        title_en: titleEn,
        status: queueStatus,
        reason: primaryReason,
        shopifyStatus,
        metadata: { ...buildMetadata(record, [...elite.reasons, ...regra.reasons, ...gateReasons], titleEs), ...metaExtras },
      };
      queue.items.push(newItem);
      bySku.set(record.sku, { item: newItem, index: queue.items.length - 1 });
    }
  }

}

/**
 * @param {import('../importer/types.js').ProductRecord} record
 * @param {string[]} reasons
 * @param {string} titleEs
 */
function buildMetadata(record, reasons, titleEs) {
  return {
    title_es: titleEs,
    vendor: record.vendor || null,
    category: record.categoryMain || record.category || null,
    category_es: record._source?.category || null,
    curationReasons: reasons,
    netPrice: record.netPrice ?? null,
    grossPrice: record.grossPrice ?? null,
    availableQuantity: record.availableQuantity ?? null,
    queuedAt: new Date().toISOString(),
    approvedAt: null,
    rejectedAt: null,
  };
}

/**
 * Aprova manualmente — próxima sincronização força ACTIVE no Shopify.
 * @param {string} sku
 */
/**
 * @param {string} sku
 * @param {{ title?: string, vendor?: string, categoryMain?: string }} [meta]
 */
export async function approveProduct(sku, meta = {}) {
  return escrever("approveProduct", [sku, meta], () => withCurationQueueLock(() => approveProductLocked(sku, meta)));
}

/**
 * @param {string} sku
 * @param {{ title?: string, vendor?: string, categoryMain?: string }} [meta]
 */
async function approveProductLocked(sku, meta = {}) {
  const queue = await loadCurationQueue();
  let item = queue.items.find((i) => i.sku === sku);
  // Lote 1 (DBG-11): um PUBLISHED não passa a APPROVED por esta via.
  assertApprovable(item);
  const previousSnapshot = snapshotQueueItem(item);
  if (!item) {
    item = {
      sku,
      title_en: meta.title || sku,
      status: "PENDING",
      reason: "manual_dashboard",
      shopifyStatus: "DRAFT",
      metadata: {
        vendor: meta.vendor || null,
        category: meta.categoryMain || null,
        approvedAt: null,
        rejectedAt: null,
        queuedAt: new Date().toISOString(),
      },
    };
    queue.items.push(item);
  }

  item.status = "APPROVED";
  item.statusChangedAt = new Date().toISOString();
  item.shopifyStatus = "ACTIVE";
  item.metadata = {
    ...item.metadata,
    approvedAt: new Date().toISOString(),
    rejectedAt: null,
    origem: "humano",
  };

  await saveCurationQueue(queue);
  return { item, previousSnapshot };
}

/**
 * Rejeita manualmente — próxima sincronização mantém DRAFT.
 * @param {string} sku
 */
/**
 * @param {string} sku
 * @param {{ title?: string, vendor?: string, categoryMain?: string }} [meta]
 */
export async function rejectProduct(sku, meta = {}) {
  return escrever("rejectProduct", [sku, meta], () => withCurationQueueLock(() => rejectProductLocked(sku, meta)));
}

/**
 * @param {string} sku
 * @param {{ title?: string, vendor?: string, categoryMain?: string }} [meta]
 */
async function rejectProductLocked(sku, meta = {}) {
  const queue = await loadCurationQueue();
  let item = queue.items.find((i) => i.sku === sku);
  const previousSnapshot = snapshotQueueItem(item);
  if (!item) {
    item = {
      sku,
      title_en: meta.title || sku,
      status: "PENDING",
      reason: "manual_dashboard",
      shopifyStatus: "DRAFT",
      metadata: {
        vendor: meta.vendor || null,
        category: meta.categoryMain || null,
        approvedAt: null,
        rejectedAt: null,
        queuedAt: new Date().toISOString(),
      },
    };
    queue.items.push(item);
  }

  item.status = "REJECTED";
  item.statusChangedAt = new Date().toISOString();
  item.shopifyStatus = "DRAFT";
  item.metadata = {
    ...item.metadata,
    rejectedAt: new Date().toISOString(),
    approvedAt: null,
    origem: "humano",
  };

  await saveCurationQueue(queue);
  return { item, previousSnapshot };
}

/**
 * @param {string[]} skus
 * @param {'APPROVED'|'REJECTED'} targetStatus
 */
export async function bulkSetQueueStatus(skus = [], targetStatus = "APPROVED") {
  return escrever("bulkSetQueueStatus", [skus, targetStatus], () =>
    withCurationQueueLock(() => bulkSetQueueStatusLocked(skus, targetStatus))
  );
}

async function bulkSetQueueStatusLocked(skus = [], targetStatus = "APPROVED") {
  const queue = await loadCurationQueue();
  const skuSet = new Set((skus || []).filter(Boolean));
  // Lote 1 (DBG-11): PUBLISHED não passa a APPROVED por aqui. Recusa o lote inteiro antes de mutar.
  assertTransitionAllowed(
    queue.items.filter((i) => skuSet.has(i.sku)),
    targetStatus
  );
  /** @type {Array<{ sku: string, status: string, shopifyStatus: string, metadata: Record<string, unknown> }>} */
  const previousSnapshots = [];
  /** @type {CurationQueueItem[]} */
  const updatedItems = [];

  for (const item of queue.items) {
    if (!skuSet.has(item.sku)) continue;
    previousSnapshots.push(snapshotQueueItem(item));
    item.status = targetStatus;
    item.statusChangedAt = new Date().toISOString();
    item.shopifyStatus = targetStatus === "APPROVED" ? "ACTIVE" : "DRAFT";
    item.metadata = {
      ...item.metadata,
      approvedAt: targetStatus === "APPROVED" ? new Date().toISOString() : null,
      rejectedAt: targetStatus === "REJECTED" ? new Date().toISOString() : null,
      origem: "humano",
    };
    updatedItems.push(item);
    skuSet.delete(item.sku);
  }

  // Handle SKUs that are not yet in the queue
  for (const sku of skuSet) {
    const previousSnapshot = snapshotQueueItem(null);
    previousSnapshots.push({ ...previousSnapshot, sku });
    const newItem = {
      sku,
      title_en: sku, // We don't have full metadata here, but SKU is enough
      status: targetStatus,
      reason: "manual_dashboard_bulk",
      shopifyStatus: targetStatus === "APPROVED" ? "ACTIVE" : "DRAFT",
      metadata: {
        vendor: null,
        category: null,
        approvedAt: targetStatus === "APPROVED" ? new Date().toISOString() : null,
        rejectedAt: targetStatus === "REJECTED" ? new Date().toISOString() : null,
        queuedAt: new Date().toISOString(),
        origem: "humano",
      },
    };
    queue.items.push(newItem);
    updatedItems.push(newItem);
  }

  await saveCurationQueue(queue);
  return { updatedItems, previousSnapshots };
}

/**
 * Aprovar/rejeitar em massa SÓ produtos PENDING (Decisão 31): numa só operação sob o lock da
 * fila, cada SKU pedido é
 *   - PENDING → transita para o estado pedido;
 *   - sem entrada na fila → conta como PENDING: cria a entrada (reason manual_dashboard_bulk)
 *     e transita; vem em `created`/`createdCount`, à parte do resto;
 *   - PUBLISHED / REJECTED / SYNC_ERROR / APPROVED → ignorado, nunca alterado (vem em `skipped`).
 * Idempotente: repetir a ação não cria duplicados e o que já foi decidido fica ignorado.
 * `previousSnapshots` serve ao undo; as entradas criadas levam `created: true` (o undo apaga-as).
 * `skus` são só os alterados.
 * @param {string[]} skus
 * @param {'APPROVED'|'REJECTED'} targetStatus
 */
export async function bulkTransitionPending(skus = [], targetStatus = "APPROVED") {
  return escrever("bulkTransitionPending", [skus, targetStatus], () =>
    withCurationQueueLock(() => bulkTransitionPendingLocked(skus, targetStatus))
  );
}

async function bulkTransitionPendingLocked(skus = [], targetStatus = "APPROVED") {
  if (targetStatus !== "APPROVED" && targetStatus !== "REJECTED") {
    throw new Error(`bulkTransitionPending: estado inválido (${targetStatus})`);
  }
  const queue = await loadCurationQueue();
  const { eligible, toCreate, skipped } = partitionBulkEligible(queue.items, skus);
  const createSet = new Set(toCreate);
  const index = getQueueIndexBySku(queue);
  const nowIso = new Date().toISOString();
  /** @type {Array<object>} */
  const previousSnapshots = [];
  /** @type {CurationQueueItem[]} */
  const updatedItems = [];
  const created = [];

  for (const sku of eligible) {
    let item = index.get(sku);
    if (createSet.has(sku)) {
      item = {
        sku,
        title_en: sku,
        status: "PENDING",
        reason: "manual_dashboard_bulk",
        shopifyStatus: "DRAFT",
        metadata: { vendor: null, category: null, approvedAt: null, rejectedAt: null, queuedAt: nowIso },
      };
      queue.items.push(item);
      created.push(sku);
      previousSnapshots.push({ sku, created: true });
    } else {
      previousSnapshots.push(snapshotQueueItem(item));
    }
    item.status = targetStatus;
    item.statusChangedAt = nowIso;
    item.shopifyStatus = targetStatus === "APPROVED" ? "ACTIVE" : "DRAFT";
    item.metadata = {
      ...item.metadata,
      approvedAt: targetStatus === "APPROVED" ? nowIso : null,
      rejectedAt: targetStatus === "REJECTED" ? nowIso : null,
      origem: "humano",
    };
    updatedItems.push(item);
  }

  if (updatedItems.length) await saveCurationQueue(queue);
  return {
    updatedItems,
    previousSnapshots,
    skus: updatedItems.map((i) => i.sku),
    created,
    createdCount: created.length,
    skipped,
  };
}

/**
 * Margem por produto (barra de seleção da Curadoria) — grava em metadata.overrides,
 * que o reindex preserva como os restantes overrides. `null` apaga e o produto volta à
 * margem global. O valor tem de vir já validado (assertMarginPct) pelo chamador.
 * Só pesa na criação: um produto já publicado mantém o preço live (o publisher avisa).
 * @param {string[]} skus
 * @param {number|null} marginPct
 */
export async function bulkSetMarginPct(skus = [], marginPct = null) {
  return escrever("bulkSetMarginPct", [skus, marginPct], () =>
    withCurationQueueLock(() => bulkSetMarginPctLocked(skus, marginPct))
  );
}

async function bulkSetMarginPctLocked(skus = [], marginPct = null) {
  const queue = await loadCurationQueue();
  const skuSet = new Set((skus || []).filter(Boolean));
  const now = new Date().toISOString();
  /** @type {CurationQueueItem[]} */
  const updatedItems = [];
  for (const item of queue.items) {
    if (!skuSet.has(item.sku)) continue;
    const { marginPct: _prev, ...rest } = item.metadata?.overrides || {};
    item.metadata = {
      ...item.metadata,
      overrides: marginPct == null ? rest : { ...rest, marginPct },
      overridesUpdatedAt: now,
    };
    updatedItems.push(item);
    skuSet.delete(item.sku);
  }
  await saveCurationQueue(queue);
  return { updatedItems, missing: [...skuSet] };
}

/**
 * Override manual de título/preço/categoria — usado pelo re-import de CSV (item 9
 * do roadmap). Só grava os campos passados (undefined preserva o valor anterior);
 * lido em applyManualOverrides() no publisher, aplicado depois do mapeamento do
 * fornecedor, antes de enviar para a Shopify.
 *
 * Preço manual (Decisão 31): quando o preço do override muda (ou ainda não tem registo),
 * `overrides.priceMeta = { by, at, reason }` guarda quem o fixou, quando e porquê. O mesmo
 * preço outra vez não é edição e preserva o registo anterior.
 * @param {string} sku
 * @param {{ title?: string, price?: number, category?: string }} overrides
 * @param {{ by?: string|null, reason?: string|null }} [meta] autor e motivo do preço manual
 */
export async function setManualOverride(sku, overrides = {}, meta = {}) {
  return escrever("setManualOverride", [sku, overrides, meta], () =>
    withCurationQueueLock(() => setManualOverrideLocked(sku, overrides, meta))
  );
}

/**
 * @param {string} sku
 * @param {{ title?: string, price?: number, category?: string }} overrides
 * @param {{ by?: string|null, reason?: string|null }} [meta]
 */
async function setManualOverrideLocked(sku, overrides = {}, meta = {}) {
  const queue = await loadCurationQueue();
  let item = queue.items.find((i) => i.sku === sku);
  if (!item) {
    item = {
      sku,
      title_en: overrides.title || sku,
      status: "PENDING",
      reason: "manual_dashboard",
      shopifyStatus: "DRAFT",
      metadata: {
        approvedAt: null,
        rejectedAt: null,
        queuedAt: new Date().toISOString(),
      },
    };
    queue.items.push(item);
  }

  const prevOverrides = item.metadata?.overrides || {};
  const priceEdited =
    overrides.price !== undefined && (!prevOverrides.priceMeta || Number(prevOverrides.price) !== Number(overrides.price));
  item.metadata = {
    ...item.metadata,
    overrides: {
      ...prevOverrides,
      ...(overrides.title !== undefined ? { title: overrides.title } : {}),
      ...(overrides.price !== undefined ? { price: overrides.price } : {}),
      ...(priceEdited
        ? {
            priceMeta: {
              by: meta?.by ? String(meta.by) : null,
              at: new Date().toISOString(),
              reason: meta?.reason ? String(meta.reason).trim().slice(0, 300) : null,
            },
          }
        : {}),
      ...(overrides.category !== undefined ? { category: overrides.category } : {}),
    },
    overridesUpdatedAt: new Date().toISOString(),
  };

  await saveCurationQueue(queue);
  return { item };
}

/**
 * @param {Array<{ sku: string, status: string, shopifyStatus?: string, metadata?: Record<string, unknown> }>} snapshots
 */
export async function restoreQueueSnapshots(snapshots = []) {
  return escrever("restoreQueueSnapshots", [snapshots], () => withCurationQueueLock(() => restoreQueueSnapshotsLocked(snapshots)));
}

async function restoreQueueSnapshotsLocked(snapshots = []) {
  const queue = await loadCurationQueue();
  const bySku = new Map(snapshots.filter((s) => s?.sku).map((s) => [s.sku, s]));
  const restored = [];
  // Entradas criadas por uma ação em massa (snapshot { created: true }): o undo apaga-as, nunca
  // as deixa com estado indefinido — mas só se ainda estiverem como a ação as deixou (APPROVED
  // ou REJECTED sem outra alteração), para não apagar uma entrada que entretanto andou.
  const createdSkus = new Set(snapshots.filter((s) => s?.sku && s.created === true).map((s) => s.sku));
  if (createdSkus.size) {
    queue.items = queue.items.filter((item) => {
      if (!createdSkus.has(item.sku)) return true;
      const untouched = (item.status === "APPROVED" || item.status === "REJECTED") && item.reason === "manual_dashboard_bulk";
      if (untouched) {
        restored.push(item);
        return false;
      }
      return true;
    });
  }
  /** @type {string[]} */
  const skipped = [];
  for (const item of queue.items) {
    const snap = bySku.get(item.sku);
    if (!snap || snap.created === true) continue;
    // Decisão 3 (DBG-04): o undo não mexe num item com id da Shopify, seja qual for o snapshot. Fica como
    // está e é reportado em `skipped`.
    // Decisão 1 (alerta): um item com alerta de publicado (rejeitado depois de a Shopify já o ter criado)
    // também fica como está e é reportado em `skipped`. O alerta é a única marca de que o produto existe.
    if (item.metadata?.shopifyProductId || item.metadata?.alertaPublicadoNaShopify) {
      skipped.push(item.sku);
      continue;
    }
    // DBG-11: o undo nunca devolve um PUBLISHED a APPROVED. Um snapshot antigo de APPROVED
    // apagaria o vínculo à Shopify (shopifyProductId, publishedAt). Fica como está e é reportado.
    if (item.status === "PUBLISHED" && snap.status === "APPROVED") {
      skipped.push(item.sku);
      continue;
    }
    item.status = snap.status;
    // Decisão 4: a origem restaurada decide a marca. Humano ou sem origem grava statusChangedAt, que protege o
    // estado contra o flush do worker (D2). Regra, elite e reset devolvem o item às regras: sem marca, para que
    // a regra o recalcule quando muda, e uma marca antiga também sai. Trade-off aceite: uma indexação iniciada
    // antes do undo pode repor o recálculo de um item de regra, porque esse recálculo é da regra, não de uma
    // decisão humana.
    const origemRestaurada = origemExplicita(snap.metadata);
    item.statusChangedAt = ["regra", "elite", "reset"].includes(origemRestaurada) ? null : new Date().toISOString();
    item.shopifyStatus = snap.shopifyStatus || item.shopifyStatus;
    // Decisão 4: o desfazer repõe a origem do snapshot. Não grava "humano" por defeito, para que um item de
    // regra desfeito continue de regra e volte a recalcular-se quando a regra muda. Um snapshot sem origem
    // (anterior à gravação de origem) fica sem origem; o statusChangedAt que o undo grava faz dele humano.
    item.metadata = { ...(snap.metadata || {}) };
    restored.push(item);
  }
  await saveCurationQueue(queue);
  return { restored, skipped, skippedCount: skipped.length };
}

/**
 * @param {string} sku
 * @param {string} shopifyProductId
 * @param {{ costAtPublish?: number|null, lastPriceWrite?: object|null }} [opts] costAtPublish — netPrice no momento
 *   da primeira publicação; só gravado da primeira vez. Serve à reconciliação de preços
 *   para reconhecer o × 1,4 antigo (priceReconcile.server.js). lastPriceWrite — só quando
 *   esta publicação escreveu mesmo um preço na Shopify (lastPriceWrite.js); sem ele, o
 *   registo anterior mantém-se.
 */
export async function markQueueItemPublished(sku, shopifyProductId, opts = {}) {
  return escrever("markQueueItemPublished", [sku, shopifyProductId, opts], () =>
    withCurationQueueLock(() => markQueueItemPublishedLocked(sku, shopifyProductId, opts))
  );
}

/**
 * Estado atual de um SKU, lido do disco dentro do lock (DBG-04, Decisão 2). O motor de publicação
 * chama-o antes de criar cada produto: uma decisão humana tomada durante a corrida aparece aqui,
 * mesmo que a corrida tenha lido a fila no arranque.
 * @param {string} sku
 * @returns {Promise<string|null>} estado, ou null se o SKU não está na fila
 */
export async function lerEstadoAtualNaFila(sku) {
  return withCurationQueueLock(async () => {
    const queue = await loadCurationQueue();
    return queue.items.find((i) => i.sku === sku)?.status ?? null;
  });
}

async function markQueueItemPublishedLocked(sku, shopifyProductId, opts = {}) {
  const queue = await loadCurationQueue();
  const item = queue.items.find((i) => i.sku === sku);
  if (!item) return null;

  // Decisão 2 (DBG-04): o produto já foi criado na Shopify. Se a decisão humana mudou durante a
  // criação (rejeição, por exemplo), o estado não se toca e fica um alerta para o painel. Sem
  // despublicação automática.
  if (item.status !== "APPROVED") {
    item.metadata = {
      ...item.metadata,
      alertaPublicadoNaShopify: { shopifyProductId, em: new Date().toISOString() },
    };
    await saveCurationQueue(queue);
    return item;
  }

  item.status = "PUBLISHED";
  item.shopifyStatus = "ACTIVE";
  item.metadata = {
    ...item.metadata,
    shopifyProductId,
    publishedAt: new Date().toISOString(),
    syncError: null,
    syncErrorAt: null,
    costAtPublish:
      item.metadata?.costAtPublish ??
      (Number.isFinite(opts.costAtPublish) ? opts.costAtPublish : null),
    ...(opts.lastPriceWrite ? { lastPriceWrite: opts.lastPriceWrite } : {}),
  };

  await saveCurationQueue(queue);
  return item;
}

/**
 * Grava a última escrita de preço de vários SKUs numa só passagem pela fila (uma leitura,
 * um save — nunca um save de 15 MB por SKU). Usado pela ação "aplicar aos publicados" e
 * pelo preenchimento inicial. SKU que não está na fila NÃO é ignorado em silêncio: vem em
 * `missing`, para o chamador o reportar.
 *
 * Decisão 31: o mesmo ponto grava o histórico de preços (tabela PriceHistory, com a regra de
 * cálculo e a data), depois de largar o lock da fila. O preço já está na Shopify, por isso uma
 * falha do histórico não desfaz nada: é registada em log e devolvida em `historyError` (o
 * chamador reporta). O backfill não entra no histórico (não é uma escrita datada).
 * @param {Array<{ sku: string, write: object }>} entries write = saída de buildLastPriceWrite
 * @param {{ shop?: string|null, recordHistory?: Function }} [opts] shop do histórico (omissão:
 *   SHOPIFY_SHOP_URL); recordHistory injetável nos testes
 * @returns {Promise<{ recorded: string[], missing: string[], historyRecorded: number, historyError: string|null }>}
 */
export async function recordLastPriceWrites(entries = [], opts = {}) {
  // O histórico de preço grava-se no principal: o pedido segue inteiro para lá.
  if (remoto) return remoto.pedir("recordLastPriceWrites", [entries]);
  const result = await withCurationQueueLock(() => recordLastPriceWritesLocked(entries));
  let historyRecorded = 0;
  let historyError = null;
  try {
    const recordHistory = opts.recordHistory || (await import("../importer/pricing/priceHistory.server.js")).recordPriceHistory;
    historyRecorded = (await recordHistory(entries, { shop: opts.shop })).recorded;
  } catch (err) {
    historyError = err?.message || String(err);
    console.error(`[price-history] histórico de preço não gravado: ${historyError}`);
  }
  return { ...result, historyRecorded, historyError };
}

async function recordLastPriceWritesLocked(entries = []) {
  const recorded = [];
  const missing = [];
  if (!entries.length) return { recorded, missing };
  const queue = await loadCurationQueue();
  const index = getQueueIndexBySku(queue);
  for (const { sku, write } of entries) {
    const item = index.get(sku);
    if (!item) {
      missing.push(sku);
      continue;
    }
    item.metadata = { ...item.metadata, lastPriceWrite: write };
    recorded.push(sku);
  }
  if (recorded.length) await saveCurationQueue(queue);
  return { recorded, missing };
}

/**
 * Produto apagado no admin da Shopify (decisão do Carlos de 09/10/2026): o item volta a
 * PENDING com a nota "apagado no admin" e a data, e só é republicado com aprovação nova.
 * Nunca escreve APPROVED. Guarda o que havia (id do produto, última escrita) em
 * metadata.deletedInAdmin, porque a última escrita deixa de descrever a loja.
 * @param {string} sku
 * @param {{ at?: string }} [opts]
 * @returns {Promise<object|null>} o item, ou null se o SKU não está na fila
 */
export async function markQueueItemDeletedInAdmin(sku, opts = {}) {
  return escrever("markQueueItemDeletedInAdmin", [sku, opts], () =>
    withCurationQueueLock(() => markQueueItemDeletedInAdminLocked(sku, opts))
  );
}

async function markQueueItemDeletedInAdminLocked(sku, opts = {}) {
  const queue = await loadCurationQueue();
  const item = getQueueIndexBySku(queue).get(sku);
  if (!item) return null;
  applyDeletedInAdmin(item, opts.at || new Date().toISOString());
  await saveCurationQueue(queue);
  return item;
}

/**
 * Estado «apagado no admin» (regra de 09/10/2026): PENDING, retido, sem o id da Shopify, que
 * fica guardado em deletedInAdmin. Usado ao marcar à mão e pelo reset da loja (Lote 1).
 * Muda o item em memória; quem chama grava a fila.
 * @param {CurationQueueItem} item
 * @param {string} at
 */
export function applyDeletedInAdmin(item, at) {
  const { shopifyProductId, lastPriceWrite, ...rest } = item.metadata || {};
  item.status = "PENDING";
  item.statusChangedAt = at;
  item.shopifyStatus = "DRAFT";
  item.reason = "apagado no admin";
  item.metadata = {
    ...rest,
    syncError: null,
    syncErrorAt: null,
    wasPublished: true,
    deletedInAdmin: {
      at,
      note: "apagado no admin",
      previousShopifyProductId: shopifyProductId ?? null,
      lastPriceWrite: lastPriceWrite ?? null,
    },
  };
  return item;
}

/**
 * @param {string} sku
 * @param {string} message
 */
export async function markQueueItemSyncError(sku, message) {
  return escrever("markQueueItemSyncError", [sku, message], () =>
    withCurationQueueLock(() => markQueueItemSyncErrorLocked(sku, message))
  );
}

async function markQueueItemSyncErrorLocked(sku, message) {
  const queue = await loadCurationQueue();
  const item = queue.items.find((i) => i.sku === sku);
  if (!item) return null;

  // Decisão 2 (DBG-04), interpretação: o erro de sincronização não sobrepõe uma decisão humana tomada
  // durante a corrida. Só um item ainda APPROVED passa a SYNC_ERROR.
  if (item.status !== "APPROVED") return item;

  item.status = "SYNC_ERROR";
  item.metadata = {
    ...item.metadata,
    syncError: String(message).slice(0, 2000),
    syncErrorAt: new Date().toISOString(),
  };

  await saveCurationQueue(queue);
  return item;
}

/**
 * SKUs prontos para publicação Shopify (apenas APPROVED).
 */
export async function listApprovedSkusForShopifySync() {
  return listCurationQueueItems("APPROVED").then((items) => items.map((i) => i.sku));
}

/**
 * Escrita de fila com recurso ao processo principal. No principal executa `local` (dentro do lock).
 * Num processo filho com escritor remoto envia a operação ao principal e espera a confirmação.
 * @param {string} operacao nome exportado em ESCRITAS_REMOTAS
 * @param {unknown[]} argumentos
 * @param {() => Promise<any>} local
 */
function escrever(operacao, argumentos, local) {
  return remoto ? remoto.pedir(operacao, argumentos) : local();
}

/**
 * Edição da fila feita pelo processo principal (reset Shopify, purga de elite, scripts sem IPC).
 * A função recebe a fila lida de novo, dentro do lock, e devolve { gravar, valor }. Só grava se
 * `gravar` for true. Não é enviável por IPC: num filho lança erro (fail closed).
 * @template T
 * @param {(fila: { version: number, updatedAt: string | null, items: CurationQueueItem[] }) => { gravar: boolean, valor: T } | Promise<{ gravar: boolean, valor: T }>} fn
 * @returns {Promise<T>}
 */
export async function mutateCurationQueue(fn) {
  recusarSeRemoto("mutateCurationQueue");
  return withCurationQueueLock(async () => {
    const fila = await loadCurationQueue();
    const { gravar, valor } = await fn(fila);
    if (gravar) await escreverFila(fila);
    return valor;
  });
}

/** Operações de escrita que um processo filho pode pedir ao principal. Só estas são atendidas. */
const ESCRITAS_REMOTAS = {
  flushCurationQueueItems,
  upsertCurationQueueFromRecord,
  upsertCurationQueueBatchFromRecords,
  approveProduct,
  rejectProduct,
  bulkSetQueueStatus,
  bulkTransitionPending,
  bulkSetMarginPct,
  setManualOverride,
  restoreQueueSnapshots,
  markQueueItemPublished,
  recordLastPriceWrites,
  markQueueItemDeletedInAdmin,
  markQueueItemSyncError,
};

const PEDIDO_ESCRITA = "curation-write";
const RESPOSTA_ESCRITA = "curation-write-result";

/**
 * Processo filho (worker de indexação, harness de teste): passa as escritas da fila ao principal.
 * Chamar uma vez, antes de qualquer escrita. `processo` é o `process` (ou um processo fork).
 * @param {{ send: Function, on: Function }} processo
 */
export function usarEscritorDoPrincipal(processo) {
  if (remoto) return;
  /** @type {Map<string, { resolve: Function, reject: Function }>} */
  const pendentes = new Map();
  let sequencia = 0;

  processo.on("message", (mensagem) => {
    if (mensagem?.type !== RESPOSTA_ESCRITA) return;
    const pedido = pendentes.get(mensagem.id);
    if (!pedido) return;
    pendentes.delete(mensagem.id);
    if (mensagem.ok) pedido.resolve(mensagem.value);
    else pedido.reject(Object.assign(new Error(mensagem.error), { code: mensagem.code || undefined }));
  });
  processo.on("disconnect", () => {
    for (const pedido of pendentes.values()) pedido.reject(new Error("canal com o processo principal fechado"));
    pendentes.clear();
  });

  remoto = {
    pedir(operacao, argumentos) {
      return new Promise((resolve, reject) => {
        sequencia += 1;
        const id = `${process.pid}:${sequencia}`;
        pendentes.set(id, { resolve, reject });
        processo.send({ type: PEDIDO_ESCRITA, id, op: operacao, args: argumentos }, (erro) => {
          if (erro) {
            pendentes.delete(id);
            reject(erro);
          }
        });
      });
    },
  };
}

/**
 * Processo principal: atende um pedido de escrita vindo de um filho. Executa a operação com a
 * função pública (dentro do lock) e devolve o resultado com `responder`.
 * @param {{ type?: string, id?: string, op?: string, args?: unknown[] }} mensagem
 * @param {(resposta: object) => void} responder
 */
export function handleCurationWriteMessage(mensagem, responder) {
  const { id, op } = mensagem || {};
  if (!Object.prototype.hasOwnProperty.call(ESCRITAS_REMOTAS, op)) {
    responder({ type: RESPOSTA_ESCRITA, id, ok: false, error: `operação de escrita não permitida: ${op}` });
    return;
  }
  const funcao = ESCRITAS_REMOTAS[op];
  const argumentos = Array.isArray(mensagem.args) ? mensagem.args : [];
  Promise.resolve()
    .then(() => funcao(...argumentos))
    .then(
      (valor) => responder({ type: RESPOSTA_ESCRITA, id, ok: true, value: valor ?? null }),
      (err) => responder({ type: RESPOSTA_ESCRITA, id, ok: false, error: String(err?.message || err), code: err?.code ?? null })
    );
}

export { QUEUE_PATH };
