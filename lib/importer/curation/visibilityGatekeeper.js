import { collectFranchiseHaystacks } from "../connectors/ociostock/parseFamilies.js";
import { loadCuration, normalizeForMatch } from "./loadCuration.js";
import { isPremiumBrand } from "./eliteCuration.server.js";

/**
 * Gatekeeper de visibilidade Shopify (ACTIVE vs DRAFT).
 *
 * Precedência:
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
let queueCacheAt = 0;
const QUEUE_CACHE_MS = 2000;

async function getQueueEntryCached(sku) {
  const now = Date.now();
  if (!queueCache || now - queueCacheAt > QUEUE_CACHE_MS) {
    const { loadCurationQueue } = await import("../../curation/curationQueue.server.js");
    queueCache = await loadCurationQueue();
    queueCacheAt = now;
  }
  return queueCache.items.find((item) => item.sku === sku) ?? null;
}

/** Invalida cache após approve/reject na API. */
export function invalidateCurationQueueCache() {
  queueCache = null;
  queueCacheAt = 0;
}

/**
 * Status final para Shopify: regras + fila manual (server/data/curation-queue.json).
 * @param {import('../types.js').ProductRecord} record
 * @returns {Promise<{ status: 'ACTIVE' | 'DRAFT', reasons: string[] }>}
 */
export async function resolveProductStatus(record) {
  const entry = await getQueueEntryCached(record.sku);

  if (entry?.status === "APPROVED") {
    return {
      status: "ACTIVE",
      reasons: ["manual_approved", entry.reason].filter(Boolean),
    };
  }

  if (entry?.status === "REJECTED") {
    return {
      status: "DRAFT",
      reasons: ["manual_rejected", entry.reason].filter(Boolean),
    };
  }

  return evaluateCurationRules(record);
}

/**
 * Versão síncrona (só regras automáticas) — usada ao enfileirar no CSV.
 * @param {import('../types.js').ProductRecord} record
 */
export function resolveProductStatusSync(record) {
  return evaluateCurationRules(record);
}
