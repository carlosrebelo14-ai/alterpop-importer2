import { logExecution } from "../logging/executionHistory.js";
import { lookupCategoryGlossary, translateCategory } from "./glossary/index.js";

const UNTRANSLATED_PREFIX = "[UNTRANSLATED]";

/**
 * Normaliza categoria ES → EN para persistência (SQLite / Shopify).
 * Valores sem glossário: prefixo [UNTRANSLATED] + log em execution-history.log.
 *
 * @param {string} value
 * @param {{ sku?: string, jobId?: string, field?: string }} [ctx]
 */
export function normalizeCategoryForStorage(value, ctx = {}) {
  const original = String(value || "").trim();
  if (!original) return "";

  const glossaryHit = lookupCategoryGlossary(original);
  if (glossaryHit) return glossaryHit;

  const translated = translateCategory(original);
  if (translated && translated !== original) return translated;

  const flagged = `${UNTRANSLATED_PREFIX} ${original}`;
  const sku = ctx.sku || "(catalog)";
  const reason = `category_untranslated:${ctx.field || "category"}:${original}`;

  logExecution({
    sku,
    action: "rejeitado",
    reason,
    jobId: ctx.jobId,
  }).catch((err) => console.error("[normalizeCategory] log:", err?.message || err));

  return flagged;
}

/**
 * @param {import('../types.js').ProductRecord} record
 * @param {{ sku?: string, jobId?: string }} [ctx]
 */
export function normalizeRecordCategories(record, ctx = {}) {
  const base = { sku: ctx.sku || record.sku, jobId: ctx.jobId };

  if (record.category?.trim()) {
    record.category = normalizeCategoryForStorage(record.category, {
      ...base,
      field: "category",
    });
  }
  if (record.categoryMain?.trim()) {
    record.categoryMain = normalizeCategoryForStorage(record.categoryMain, {
      ...base,
      field: "categoryMain",
    });
  }
  if (Array.isArray(record.categorySegments)) {
    record.categorySegments = record.categorySegments
      .filter(Boolean)
      .map((seg, i) =>
        normalizeCategoryForStorage(seg, { ...base, field: `categorySegments[${i}]` })
      );
  }
  if (record.categoryMain) {
    record.category = record.categoryMain;
  }
}
