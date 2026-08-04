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

  // Título já veio pronto em inglês do fornecedor (ver csvFieldMap → supplierTitle.js):
  // não passa pelo glossário nem pela API. É este desvio que corta ~99% das chamadas à
  // camada 3 e evita reprocessar texto que já está correto.
  const supplierTitleUsed = record.titleSource === "supplier";

  if (translateTitle && record.title?.trim() && !supplierTitleUsed) {
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
