import { normalizeRecordCategories } from "../transform/normalizeCategory.js";
import { translateTitleFromGlossary } from "../transform/glossary/translateTitle.js";

/**
 * Apply deterministic ES → EN glossary (categorias + títulos) on one record.
 * @param {import('../types.js').ProductRecord} record
 * @param {import('../jobs/ImportJob.js').ImportJob} job
 */
/**
 * @param {import('../types.js').ProductRecord} record
 * @param {import('../jobs/ImportJob.js').ImportJob | null} job
 * @param {{ translateTitle?: boolean }} [opts]
 */
export function transformOcioStockRecord(record, job, opts = {}) {
  const translateTitle = opts.translateTitle !== false;

  if (translateTitle && record.title?.trim()) {
    const originalTitle = record.title;
    record.title = translateTitleFromGlossary(record.title);
    if (record.title !== originalTitle) {
      record._translated = record._translated || {};
      record._translated.title = record.title;
    }
  }

  normalizeRecordCategories(record, {
    sku: record.sku,
    jobId: job?.jobId,
  });
  return record;
}
