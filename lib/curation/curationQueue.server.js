import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { evaluateCurationRules } from "../importer/curation/visibilityGatekeeper.js";
import { evaluateSmartRules } from "../importer/curation/smartRules.server.js";
import { evaluateEliteCuration } from "../importer/curation/eliteCuration.server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = path.join(__dirname, "..", "..", "server", "data", "curation-queue.json");
const RESULTS_ERRORS_PATH = path.join(__dirname, "..", "..", "results", "errors.json");

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
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmp, QUEUE_PATH);
  invalidateCurationMemoryCache();
  return payload;
}

/**
 * @param {string} sku
 */
export async function getCurationQueueEntry(sku) {
  const queue = await loadCurationQueue();
  return queue.items.find((item) => item.sku === sku) ?? null;
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
      (existing.status === "APPROVED" || existing.status === "REJECTED") &&
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
 * @param {Array<{ sku: string, status: string, shopifyStatus?: string, metadata?: Record<string, unknown> }>} snapshots
 */
export async function restoreQueueSnapshots(snapshots = []) {
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
 */
export async function markQueueItemPublished(sku, shopifyProductId) {
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
  };

  await saveCurationQueue(queue);
  return item;
}

/**
 * @param {string} sku
 * @param {string} message
 */
export async function markQueueItemSyncError(sku, message) {
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
