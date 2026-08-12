import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { evaluateCurationRules } from "../importer/curation/visibilityGatekeeper.js";
import { evaluateSmartRules } from "../importer/curation/smartRules.server.js";
import { evaluateEliteCuration } from "../importer/curation/eliteCuration.server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Diretório de estado da fila de curadoria.
 *
 * Estava em `process.cwd()/server/data`, que no container é filesystem EFÉMERO: cada
 * deploy recria a imagem e apagava o ficheiro com todas as decisões de aprovação e
 * rejeição. A 2026-08-05 confirmou-se que o ficheiro nem sequer existia em produção,
 * depois de 5 deploys no mesmo dia. Todo o resto do estado (SQLite, sessões, settings)
 * já vivia em /app/data, o volume persistente — esta era a única exceção.
 *
 * Resolução por ordem:
 *   1. CURATION_DATA_DIR, se definido (escape hatch para testes e ambientes especiais)
 *   2. /app/data, quando existe — é o volume montado dentro do container
 *   3. server/data local, para desenvolvimento fora do container (comportamento antigo)
 */
function resolveCurationDataDir() {
  const override = process.env.CURATION_DATA_DIR?.trim();
  if (override) return override;
  const volumeDir = "/app/data";
  try {
    if (fsSync.statSync(volumeDir).isDirectory()) return volumeDir;
  } catch {
    /* fora do container — segue para o fallback local */
  }
  return path.join(process.cwd(), "server", "data");
}

const CURATION_DATA_DIR = resolveCurationDataDir();
const QUEUE_PATH = path.join(CURATION_DATA_DIR, "curation-queue.json");
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
// deste processo Node — suficiente aqui porque a app corre numa única máquina Fly.
let queueLock = Promise.resolve();
function withCurationQueueLock(fn) {
  const result = queueLock.then(fn, fn);
  queueLock = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * @returns {Promise<{ version: number, updatedAt: string | null, items: CurationQueueItem[] }>}
 */
export async function loadCurationQueue() {
  try {
    const stat = await fs.stat(QUEUE_PATH);
    if (cachedQueue && stat.mtimeMs === cachedQueueMtime) {
      return cachedQueue;
    }

    const raw = await fs.readFile(QUEUE_PATH, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      const recovered = await recoverCorruptedQueueJson(raw, parseErr);
      if (!recovered) {
        parsed = await resetCorruptedQueueToEmpty(raw, parseErr);
      } else {
        parsed = recovered;
      }
    }
    const result = {
      version: parsed.version ?? 1,
      updatedAt: parsed.updatedAt ?? null,
      items: Array.isArray(parsed.items) ? parsed.items : [],
    };
    cachedQueue = result;
    cachedQueueMtime = stat.mtimeMs;
    return result;
  } catch (err) {
    if (err?.code === "ENOENT") {
      return { version: 1, updatedAt: null, items: [] };
    }
    throw err;
  }
}

/**
 * Tenta recuperar `curation-queue.json` quando há caracteres inválidos em JSON.
 * Estratégia: backup do ficheiro original, sanitização de control chars e persistência do conteúdo recuperado.
 * @param {string} raw
 * @param {unknown} parseErr
 * @returns {Promise<{ version?: number, updatedAt?: string | null, items?: unknown[] } | null>}
 */
async function recoverCorruptedQueueJson(raw, parseErr) {
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

    await saveCurationQueue(recovered);
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
 * Último recurso: preserva o ficheiro corrompido e reinicia a fila vazia para não bloquear imports.
 * @param {string} raw
 * @param {unknown} parseErr
 */
async function resetCorruptedQueueToEmpty(raw, parseErr) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${QUEUE_PATH}.corrupt-reset-${timestamp}.json`;
  await fs.mkdir(path.dirname(QUEUE_PATH), { recursive: true });
  await fs.writeFile(backupPath, raw, "utf8");

  const emptyQueue = { version: 1, updatedAt: null, items: [] };
  await saveCurationQueue(emptyQueue);
  await logQueueRepairError("queue_reset_after_parse_failure", parseErr, {
    backupPath,
    itemsRecovered: 0,
  });
  return emptyQueue;
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

/**
 * @param {{ version?: number, updatedAt?: string | null, items: CurationQueueItem[] }} queue
 */
export async function saveCurationQueue(queue) {
  await fs.mkdir(path.dirname(QUEUE_PATH), { recursive: true });
  const payload = {
    version: queue.version ?? 1,
    updatedAt: new Date().toISOString(),
    items: queue.items,
  };
  const tmp = `${QUEUE_PATH}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  // Sem indentação: só um ficheiro de estado interno (nunca lido/editado por humanos),
  // e o JSON.stringify síncrono bloqueia o event loop — medido em produção (29.601
  // itens): ~249ms com indent:2 vs bem menos compacto. Ver relatório de performance.
  await fs.writeFile(tmp, JSON.stringify(payload), "utf8");
  await fs.rename(tmp, QUEUE_PATH);
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
export async function flushCurationQueueItems(items) {
  return withCurationQueueLock(() => flushCurationQueueItemsLocked(items));
}

/**
 * @param {CurationQueueItem[]} items
 */
async function flushCurationQueueItemsLocked(items) {
  if (!items?.length) return;
  const onDisk = await loadCurationQueue();
  const bySku = new Map(onDisk.items.map((item) => [item.sku, item]));
  for (const item of items) {
    bySku.set(item.sku, item);
  }
  return saveCurationQueue({ version: onDisk.version ?? 1, items: Array.from(bySku.values()) });
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
 * @param {import('../importer/types.js').ProductRecord} record
 */
export async function upsertCurationQueueFromRecord(record) {
  return withCurationQueueLock(() => upsertCurationQueueFromRecordLocked(record));
}

/**
 * @param {import('../importer/types.js').ProductRecord} record
 */
async function upsertCurationQueueFromRecordLocked(record) {
  const queue = await loadCurationQueue();
  const idx = queue.items.findIndex((item) => item.sku === record.sku);
  const elite = evaluateEliteCuration(record);
  const smart = evaluateSmartRules(record);
  const { status: ruleStatus, reasons: gateReasons } = evaluateCurationRules(record);

  const titleEn =
    record._translated?.title || record.title || record._source?.title || "";
  const titleEs = record._source?.title || record.title || "";

  let queueStatus = "PENDING";
  let shopifyStatus = ruleStatus;
  let primaryReason = gateReasons[0] || "pending_review";
  /** @type {Record<string, unknown>} */
  let metaExtras = {};

  if (elite.action === "AUTO_REJECT") {
    queueStatus = "REJECTED";
    shopifyStatus = "DRAFT";
    primaryReason = elite.reasons[0] || "elite_auto_reject";
    metaExtras = {
      eliteCuration: true,
      eliteAction: "AUTO_REJECT",
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
  } else if (smart.action === "AUTO_APPROVE") {
    queueStatus = "APPROVED";
    shopifyStatus = "ACTIVE";
    primaryReason = smart.reasons[0] || "smart_auto_approve";
    metaExtras = {
      smartRule: true,
      smartAction: "AUTO_APPROVE",
      smartRuleId: smart.rule?.id || null,
      approvedAt: new Date().toISOString(),
      rejectedAt: null,
    };
  } else if (smart.action === "AUTO_REJECT") {
    queueStatus = "REJECTED";
    shopifyStatus = "DRAFT";
    primaryReason = smart.reasons[0] || "smart_auto_reject";
    metaExtras = {
      smartRule: true,
      smartAction: "AUTO_REJECT",
      smartRuleId: smart.rule?.id || null,
      rejectedAt: new Date().toISOString(),
      approvedAt: null,
    };
  } else if (record._aiCuration === "APPROVE" && !elite.action) {
    queueStatus = "APPROVED";
    shopifyStatus = "ACTIVE";
    primaryReason = "ai_gemini_approve";
    metaExtras = {
      aiCuration: true,
      aiAction: "APPROVE",
      aiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      approvedAt: new Date().toISOString(),
      rejectedAt: null,
    };
  } else if (record._aiCuration === "REJECT" && !elite.action) {
    queueStatus = "REJECTED";
    shopifyStatus = "DRAFT";
    primaryReason = "ai_gemini_reject";
    metaExtras = {
      aiCuration: true,
      aiAction: "REJECT",
      aiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      rejectedAt: new Date().toISOString(),
      approvedAt: null,
    };
  }

  if (idx >= 0) {
    const existing = queue.items[idx];
    const isManual =
      (existing.status === "APPROVED" || existing.status === "REJECTED" || existing.status === "PUBLISHED") &&
      !existing.metadata?.smartRule &&
      !existing.metadata?.aiCuration &&
      !existing.metadata?.eliteCuration;

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
        ...buildMetadata(record, [...elite.reasons, ...smart.reasons, ...gateReasons], titleEs),
        // Overrides manuais (setManualOverride, item 9) não vêm de buildMetadata() —
        // sem isto, um reindex apaga silenciosamente qualquer título/preço/categoria
        // editado à mão via re-import de CSV (bug encontrado no code review, 2026-08-12).
        ...(existing.metadata?.overrides ? { overrides: existing.metadata.overrides, overridesUpdatedAt: existing.metadata.overridesUpdatedAt } : {}),
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
        ...buildMetadata(record, [...elite.reasons, ...smart.reasons, ...gateReasons], titleEs),
        ...metaExtras,
      },
    });
  }

  return saveCurationQueue(queue);
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
  const queue = externalQueue || (await loadCurationQueue());
  
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
    const smart = evaluateSmartRules(record);
    const { status: ruleStatus, reasons: gateReasons } = evaluateCurationRules(record);

    const titleEn = record._translated?.title || record.title || record._source?.title || "";
    const titleEs = record._source?.title || record.title || "";

    let queueStatus = "PENDING";
    let shopifyStatus = ruleStatus;
    let primaryReason = gateReasons[0] || "pending_review";
    let metaExtras = {};

    if (elite.action === "AUTO_REJECT") {
      queueStatus = "REJECTED";
      shopifyStatus = "DRAFT";
      primaryReason = elite.reasons[0] || "elite_auto_reject";
      metaExtras = { eliteCuration: true, eliteAction: "AUTO_REJECT", rejectedAt: new Date().toISOString(), approvedAt: null };
    } else if (elite.action === "PENDING_MANUAL") {
      queueStatus = "PENDING";
      shopifyStatus = "DRAFT";
      primaryReason = elite.reasons[0] || "elite_brand_not_premium";
      metaExtras = { eliteCuration: true, eliteAction: "PENDING_MANUAL", approvedAt: null, rejectedAt: null };
    } else if (smart.action === "AUTO_APPROVE") {
      queueStatus = "APPROVED";
      shopifyStatus = "ACTIVE";
      primaryReason = smart.reasons[0] || "smart_auto_approve";
      metaExtras = { smartRule: true, smartAction: "AUTO_APPROVE", approvedAt: new Date().toISOString(), rejectedAt: null };
    } else if (smart.action === "AUTO_REJECT") {
      queueStatus = "REJECTED";
      shopifyStatus = "DRAFT";
      primaryReason = smart.reasons[0] || "smart_auto_reject";
      metaExtras = { smartRule: true, smartAction: "AUTO_REJECT", rejectedAt: new Date().toISOString(), approvedAt: null };
    }

    if (existingEntry) {
      const existing = existingEntry.item;
      if (existing.status === "APPROVED" || existing.status === "REJECTED" || existing.status === "PUBLISHED") {
        existing.title_en = titleEn;
        existing.metadata = { ...existing.metadata, ...buildMetadata(record, gateReasons, titleEs), lastSeenAt: new Date().toISOString() };
      } else {
        existing.title_en = titleEn;
        existing.reason = primaryReason;
        existing.shopifyStatus = shopifyStatus;
        existing.status = queueStatus;
        existing.metadata = {
          ...buildMetadata(record, [...elite.reasons, ...smart.reasons, ...gateReasons], titleEs),
          ...(existing.metadata?.overrides ? { overrides: existing.metadata.overrides, overridesUpdatedAt: existing.metadata.overridesUpdatedAt } : {}),
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
        metadata: { ...buildMetadata(record, [...elite.reasons, ...smart.reasons, ...gateReasons], titleEs), ...metaExtras },
      };
      queue.items.push(newItem);
      bySku.set(record.sku, { item: newItem, index: queue.items.length - 1 });
    }
  }

  if (saveFile) {
    return saveCurationQueue(queue);
  }
  return queue;
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
  return withCurationQueueLock(() => approveProductLocked(sku, meta));
}

/**
 * @param {string} sku
 * @param {{ title?: string, vendor?: string, categoryMain?: string }} [meta]
 */
async function approveProductLocked(sku, meta = {}) {
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

  item.status = "APPROVED";
  item.shopifyStatus = "ACTIVE";
  item.metadata = {
    ...item.metadata,
    approvedAt: new Date().toISOString(),
    rejectedAt: null,
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
  return withCurationQueueLock(() => rejectProductLocked(sku, meta));
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
  item.shopifyStatus = "DRAFT";
  item.metadata = {
    ...item.metadata,
    rejectedAt: new Date().toISOString(),
    approvedAt: null,
  };

  await saveCurationQueue(queue);
  return { item, previousSnapshot };
}

/**
 * @param {string[]} skus
 * @param {'APPROVED'|'REJECTED'} targetStatus
 */
export async function bulkSetQueueStatus(skus = [], targetStatus = "APPROVED") {
  return withCurationQueueLock(() => bulkSetQueueStatusLocked(skus, targetStatus));
}

async function bulkSetQueueStatusLocked(skus = [], targetStatus = "APPROVED") {
  const queue = await loadCurationQueue();
  const skuSet = new Set((skus || []).filter(Boolean));
  /** @type {Array<{ sku: string, status: string, shopifyStatus: string, metadata: Record<string, unknown> }>} */
  const previousSnapshots = [];
  /** @type {CurationQueueItem[]} */
  const updatedItems = [];

  for (const item of queue.items) {
    if (!skuSet.has(item.sku)) continue;
    previousSnapshots.push(snapshotQueueItem(item));
    item.status = targetStatus;
    item.shopifyStatus = targetStatus === "APPROVED" ? "ACTIVE" : "DRAFT";
    item.metadata = {
      ...item.metadata,
      approvedAt: targetStatus === "APPROVED" ? new Date().toISOString() : null,
      rejectedAt: targetStatus === "REJECTED" ? new Date().toISOString() : null,
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
      },
    };
    queue.items.push(newItem);
    updatedItems.push(newItem);
  }

  await saveCurationQueue(queue);
  return { updatedItems, previousSnapshots };
}

/**
 * @param {string[]} skus
 * @param {number} marginMultiplier
 */
export async function bulkSetMarginMultiplier(skus = [], marginMultiplier = 1.4) {
  return withCurationQueueLock(() => bulkSetMarginMultiplierLocked(skus, marginMultiplier));
}

async function bulkSetMarginMultiplierLocked(skus = [], marginMultiplier = 1.4) {
  const queue = await loadCurationQueue();
  const skuSet = new Set((skus || []).filter(Boolean));
  const normalized = Number.isFinite(Number(marginMultiplier))
    ? Math.max(1, Number(marginMultiplier))
    : 1.4;
  /** @type {CurationQueueItem[]} */
  const updatedItems = [];
  for (const item of queue.items) {
    if (!skuSet.has(item.sku)) continue;
    item.metadata = {
      ...item.metadata,
      marginMultiplier: normalized,
      marginUpdatedAt: new Date().toISOString(),
    };
    updatedItems.push(item);
  }
  await saveCurationQueue(queue);
  return { updatedItems, marginMultiplier: normalized };
}

/**
 * Override manual de título/preço/categoria — usado pelo re-import de CSV (item 9
 * do roadmap). Só grava os campos passados (undefined preserva o valor anterior);
 * lido em applyManualOverrides() no publisher, aplicado depois do mapeamento do
 * fornecedor, antes de enviar para a Shopify.
 * @param {string} sku
 * @param {{ title?: string, price?: number, category?: string }} overrides
 */
export async function setManualOverride(sku, overrides = {}) {
  return withCurationQueueLock(() => setManualOverrideLocked(sku, overrides));
}

/**
 * @param {string} sku
 * @param {{ title?: string, price?: number, category?: string }} overrides
 */
async function setManualOverrideLocked(sku, overrides = {}) {
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
  item.metadata = {
    ...item.metadata,
    overrides: {
      ...prevOverrides,
      ...(overrides.title !== undefined ? { title: overrides.title } : {}),
      ...(overrides.price !== undefined ? { price: overrides.price } : {}),
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
  return withCurationQueueLock(() => restoreQueueSnapshotsLocked(snapshots));
}

async function restoreQueueSnapshotsLocked(snapshots = []) {
  const queue = await loadCurationQueue();
  const bySku = new Map(snapshots.filter((s) => s?.sku).map((s) => [s.sku, s]));
  const restored = [];
  for (const item of queue.items) {
    const snap = bySku.get(item.sku);
    if (!snap) continue;
    item.status = snap.status;
    item.shopifyStatus = snap.shopifyStatus || item.shopifyStatus;
    item.metadata = {
      ...(snap.metadata || {}),
    };
    restored.push(item);
  }
  await saveCurationQueue(queue);
  return { restored };
}

/**
 * @param {string} sku
 * @param {string} shopifyProductId
 * @param {{ costAtPublish?: number|null }} [opts] Item 4 — custo (netPrice) no momento
 *   da publicação, para o alerta de erosão de margem (marginErosion.server.js). Só é
 *   gravado da primeira vez: uma republicação (ex.: correção de erro de sync) não deve
 *   mover a baseline, ou a erosão nunca seria detetada.
 */
export async function markQueueItemPublished(sku, shopifyProductId, opts = {}) {
  return withCurationQueueLock(() => markQueueItemPublishedLocked(sku, shopifyProductId, opts));
}

async function markQueueItemPublishedLocked(sku, shopifyProductId, opts = {}) {
  const queue = await loadCurationQueue();
  const item = queue.items.find((i) => i.sku === sku);
  if (!item) return null;

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
  };

  await saveCurationQueue(queue);
  return item;
}

/**
 * @param {string} sku
 * @param {string} message
 */
export async function markQueueItemSyncError(sku, message) {
  return withCurationQueueLock(() => markQueueItemSyncErrorLocked(sku, message));
}

async function markQueueItemSyncErrorLocked(sku, message) {
  const queue = await loadCurationQueue();
  const item = queue.items.find((i) => i.sku === sku);
  if (!item) return null;

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

export { QUEUE_PATH };
