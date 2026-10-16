import { collectFranchiseHaystacks } from "../connectors/ociostock/parseFamilies.js";
import { loadCuration, normalizeForMatch } from "./loadCuration.js";
import { isPremiumBrand } from "./eliteCuration.server.js";

/**
 * Gatekeeper de visibilidade Shopify (ACTIVE vs DRAFT).
 *
 * O estado da Shopify vem da fila de curadoria (resolveProductStatus), nunca só das
 * regras automáticas. Só APPROVED e PUBLISHED dão ACTIVE. REJECTED, PENDING, outro
 * estado ou ausência de entrada dão DRAFT. As regras (evaluateCurationRules) alimentam
 * a fila ao indexar, mas não publicam nada sozinhas (DBG-50).
 *
 * Precedência das regras (evaluateCurationRules, usada só para preencher a fila):
 * 1. Marca não autorizada → DRAFT
 * 2. Categoria bloqueada → DRAFT (exceto franchise prioritária)
 * 3. Franchise prioritária anula bloqueio de categoria → ACTIVE
 * 4. Restantes casos aprovados → ACTIVE
 */

/**
 * @param {import('../types.js').ProductRecord} record
 * @returns {string[]}
 */
function collectCategoryCandidates(record) {
  const candidates = [
    record._source?.category,
    record.categoryMain,
    record.category,
    record.productTypePath,
    ...(record.categorySegments || []),
    ...(record.productTypePath
      ? String(record.productTypePath)
          .split("|")
          .map((s) => s.trim())
          .filter(Boolean)
      : []),
  ].filter(Boolean);

  return [...new Set(candidates.map((c) => String(c).trim()).filter(Boolean))];
}

/**
 * @param {import('../types.js').ProductRecord} record
 * @param {ReturnType<typeof loadCuration>} rules
 */
function isAllowedBrand(record, rules) {
  return isPremiumBrand(record, rules);
}

/**
 * @param {import('../types.js').ProductRecord} record
 * @param {ReturnType<typeof loadCuration>} rules
 */
function isBlockedCategory(record, rules) {
  const candidates = collectCategoryCandidates(record);
  return candidates.some((cat) => rules.blockedCategoriesExpanded.has(normalizeForMatch(cat)));
}

/**
 * @param {import('../types.js').ProductRecord} record
 * @param {ReturnType<typeof loadCuration>} rules
 */
function matchesPriorityFranchise(record, rules) {
  const needles = rules.priorityFranchisesNorm;
  if (needles.length === 0) return false;

  const haystacks = collectFranchiseHaystacks(record).map((text) => normalizeForMatch(text));

  return needles.some((needle) =>
    haystacks.some((hay) => {
      if (!hay || !needle) return false;
      const hayAscii = hay.normalize("NFD").replace(/\p{M}/gu, "");
      const needleAscii = needle.normalize("NFD").replace(/\p{M}/gu, "");
      return (
        hay.includes(needle) ||
        needle.includes(hay) ||
        hayAscii.includes(needleAscii) ||
        needleAscii.includes(hayAscii)
      );
    })
  );
}

/**
 * Regras automáticas de curadoria (sem decisão humana na fila).
 * @param {import('../types.js').ProductRecord} record
 * @returns {{ status: 'ACTIVE' | 'DRAFT', reasons: string[] }}
 */
export function evaluateCurationRules(record) {
  const rules = loadCuration();
  const reasons = [];

  if (!isAllowedBrand(record, rules)) {
    reasons.push("brand_not_allowed");
    return { status: "DRAFT", reasons };
  }

  const blocked = isBlockedCategory(record, rules);
  const priority = matchesPriorityFranchise(record, rules);

  if (blocked && priority) {
    reasons.push("priority_franchise_exception");
    return { status: "ACTIVE", reasons };
  }

  if (blocked) {
    reasons.push("blocked_category");
    return { status: "DRAFT", reasons };
  }

  reasons.push("approved");
  return { status: "ACTIVE", reasons };
}

let queueCache = null;
/** @type {Map<string, object> | null} */
let queueCacheBySku = null;
let queueCacheAt = 0;
const QUEUE_CACHE_MS = 2000;

async function getQueueEntryCached(sku) {
  const now = Date.now();
  if (!queueCache || now - queueCacheAt > QUEUE_CACHE_MS) {
    const { loadCurationQueue } = await import("../../curation/curationQueue.server.js");
    queueCache = await loadCurationQueue();
    queueCacheAt = now;
    // Fix (code review 2026-08-13): era queueCache.items.find(...) — scan linear
    // sobre ~27-30k itens por SKU avaliado. Map construído uma vez por refresh de
    // cache (a cada 2s), não por lookup.
    queueCacheBySku = new Map(queueCache.items.map((item) => [item.sku, item]));
  }
  return queueCacheBySku.get(sku) ?? null;
}

/** Invalida cache após approve/reject na API. */
export function invalidateCurationQueueCache() {
  queueCache = null;
  queueCacheBySku = null;
  queueCacheAt = 0;
}

/**
 * Estado Shopify decidido pela entrada da fila (sem regras automáticas).
 * APPROVED e PUBLISHED → ACTIVE. REJECTED → DRAFT. PENDING, outro estado ou sem
 * entrada (null) → DRAFT com `pending: true`: ainda não há decisão humana.
 * @param {{ status?: string, reason?: string } | null | undefined} entry
 * @returns {{ status: 'ACTIVE' | 'DRAFT', reasons: string[], pending: boolean, queueStatus: string | null }}
 */
export function resolveStatusFromQueueEntry(entry) {
  const queueStatus = entry?.status ?? null;

  if (queueStatus === "APPROVED" || queueStatus === "PUBLISHED") {
    return {
      status: "ACTIVE",
      reasons: ["manual_approved", entry.reason].filter(Boolean),
      pending: false,
      queueStatus,
    };
  }

  if (queueStatus === "REJECTED") {
    return {
      status: "DRAFT",
      reasons: ["manual_rejected", entry.reason].filter(Boolean),
      pending: false,
      queueStatus,
    };
  }

  return {
    status: "DRAFT",
    reasons: ["pending_review", entry?.reason].filter(Boolean),
    pending: true,
    queueStatus,
  };
}

/**
 * Status final para Shopify: fila manual (server/data/curation-queue.json).
 * `entrada` é a entrada já gravada pelo upsert do mesmo produto. Sem ela, usa a cache
 * da fila (até 2 s): uma entrada recém-gravada pode não aparecer aí. `null` = sem
 * entrada.
 * @param {import('../types.js').ProductRecord} record
 * @param {object | null} [entrada]
 * @returns {Promise<{ status: 'ACTIVE' | 'DRAFT', reasons: string[], pending: boolean, queueStatus: string | null }>}
 */
export async function resolveProductStatus(record, entrada) {
  const entry = entrada !== undefined ? entrada : await getQueueEntryCached(record.sku);
  return resolveStatusFromQueueEntry(entry);
}

/**
 * Versão síncrona (só regras automáticas) — usada ao enfileirar no CSV.
 * @param {import('../types.js').ProductRecord} record
 */
export function resolveProductStatusSync(record) {
  return evaluateCurationRules(record);
}
