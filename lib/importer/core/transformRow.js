import { normalizeRecordCategories } from "../transform/normalizeCategory.js";
import { translateTitleFromGlossary } from "../transform/glossary/translateTitle.js";
import { translateTitleWithApiFallback } from "../transform/translate.js";

/**
 * Apply deterministic ES → EN glossary (categorias + títulos) on one record.
 * @param {import('../types.js').ProductRecord} record
 * @param {import('../jobs/ImportJob.js').ImportJob} job
 */
/**
 * @param {import('../types.js').ProductRecord} record
 * @param {import('../jobs/ImportJob.js').ImportJob | null} job
 * @param {{ translateTitle?: boolean, apiFallback?: boolean }} [opts]
 */
export async function transformOcioStockRecord(record, job, opts = {}) {
  const translateTitle = opts.translateTitle !== false;
  const apiFallback = opts.apiFallback !== false;

  if (translateTitle && record.title?.trim()) {
    const originalTitle = record.title;
    record.title = translateTitleFromGlossary(record.title);

    // Camada 3: só as palavras que o glossário (camadas 1+2) não cobriu vão à API,
    // não o título inteiro — falha segura, nunca bloqueia o pipeline.
    if (apiFallback) {
      record.title = await translateTitleWithApiFallback(record);
    }

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
