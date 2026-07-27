import pLimit from "p-limit";
import fs from "fs/promises";
import { config } from "../config.js";
import { streamOcioStockRows } from "../connectors/ociostock/streamCsv.js";
import { mapOcioStockRow } from "../connectors/ociostock/csvFieldMap.js";
import { passesRecordFilters } from "../filters/passesRecordFilters.js";
import { validateRecord } from "../validation/validateRecord.js";
import { transformOcioStockRecord } from "./transformRow.js";
import { getStreamConcurrency, getSyncLimit } from "./constants.js";
import { appendFailedEntry } from "./failedLog.js";
import { translateProductRecord } from "../transform/translate.js";
import { resolveTranslationConfig } from "../transform/translationConfig.js";
import { upsertCurationQueueFromRecord } from "../../curation/curationQueue.server.js";
import { evaluateExcludeList } from "../curation/evaluateExcludeList.server.js";

/**
 * Stream OcioStock CSV → transform (glossary) → p-limit queue → Shopify importers.
 * Does not load the full catalog into RAM.
 *
 * @param {object} params
 * @param {import('../jobs/ImportJob.js').ImportJob} params.job
 * @param {import('../importers/ProductImporter.js').ProductImporter} [params.productImporter]
 * @param {import('../importers/InventoryImporter.js').InventoryImporter} [params.inventoryImporter]
 * @param {boolean} params.syncProducts
 * @param {boolean} params.syncInventory
 * @param {import('../types.js').ImportFilters} [params.filters]
 * @param {object} [params.settings]
 * @param {object} params.validationOpts
 * @param {number} [params.syncLimit]
 * @param {string[]} [params.skuAllowlist]
 * @param {(progress: { processed: number, total: number, currentSku?: string }) => void | Promise<void>} [params.onProgress]
 */
export async function runStreamImport({
  job,
  productImporter,
  inventoryImporter,
  syncProducts,
  syncInventory,
  filters = {},
  settings = {},
  validationOpts,
  syncLimit: syncLimitOverride,
  skuAllowlist = [],
  onProgress,
}) {
  const allowlistSet = skuAllowlist.length > 0 ? new Set(skuAllowlist) : null;
  const concurrency = allowlistSet ? 1 : getStreamConcurrency();
  const limit = pLimit(concurrency);
  const syncLimit = getSyncLimit(syncLimitOverride ?? settings.syncLimit);
  const batchSize = config.import.batchSize || 20;
  const batchDelayMs = config.import.batchDelayMs || 1000;
  let completedSincePause = 0;
  let pauseChain = Promise.resolve();

  const afterProductProcessed = () => {
    if (!allowlistSet) return pauseChain;
    pauseChain = pauseChain.then(async () => {
      completedSincePause += 1;
      if (completedSincePause >= batchSize) {
        completedSincePause = 0;
        job.recordBatchComplete?.();
        await new Promise((resolve) => setTimeout(resolve, batchDelayMs));
      }
    });
    return pauseChain;
  };

  const seenSkus = new Set();
  let skusQueued = 0;
  /** @type {Set<Promise<void>>} */
  const inFlight = new Set();
  const maxInFlight = concurrency * 6;

  const { translateToEnglish } = resolveTranslationConfig(settings);

  const trackTask = (promise) => {
    inFlight.add(promise);
    promise.finally(() => inFlight.delete(promise));
    if (inFlight.size >= maxInFlight) {
      return Promise.race(inFlight);
    }
    return promise;
  };

  await fs.mkdir(job.resultsDir, { recursive: true });

  const streamStats = await streamOcioStockRows({
    shouldStop: () => syncLimit > 0 && skusQueued >= syncLimit,
    onRow: async (rawRow) => {
      const record = mapOcioStockRow(rawRow);
      if (!record?.sku) return;

      const { normalizeRecordCategories } = await import("../transform/normalizeCategory.js");
      normalizeRecordCategories(record, { sku: record.sku });

      const exclude = evaluateExcludeList(record);
      if (exclude.excluded) {
        job.recordSkipped({ sku: record.sku, reason: `structured_filter:${exclude.reason}` });
        return;
      }

      if (seenSkus.has(record.sku)) return;
      seenSkus.add(record.sku);

      if (allowlistSet && !allowlistSet.has(record.sku)) {
        job.recordSkipped({ sku: record.sku, reason: "not in SKU allowlist" });
        return;
      }

      if (syncLimit > 0 && skusQueued >= syncLimit) return;

      if (!passesRecordFilters(record, filters, job)) return;

      transformOcioStockRecord(record, job, {
        translateTitle: settings.autoGlossaryTranslation !== false,
      });

      if (translateToEnglish) {
        await translateProductRecord(record, job);
      }

      const { valid, errors } = validateRecord(record, validationOpts);
      if (!valid) {
        job.recordValidationSkipped({ sku: record.sku, errors });
        return;
      }

      await upsertCurationQueueFromRecord(record);

      skusQueued += 1;
      job.metrics.totalRows = skusQueued;

      const totalTarget = syncLimit > 0 ? syncLimit : skusQueued;
      if (onProgress) {
        await onProgress({
          processed: skusQueued,
          total: totalTarget,
          currentSku: record.sku,
        });
      }

      trackTask(
        limit(async () => {
          await processRecord({
            record,
            job,
            productImporter,
            inventoryImporter,
            syncProducts,
            syncInventory,
          });
          await afterProductProcessed();
        })
      );
    },
  });

  await Promise.all(inFlight);

  return {
    rowsRead: streamStats.rowsRead,
    skusProcessed: skusQueued,
    stoppedEarly: streamStats.stoppedEarly || (syncLimit > 0 && skusQueued >= syncLimit),
    concurrency,
    syncLimit: syncLimit || null,
  };
}

/**
 * @param {object} params
 */
async function processRecord({
  record,
  job,
  productImporter,
  inventoryImporter,
  syncProducts,
  syncInventory,
}) {
  if (syncProducts && productImporter) {
    try {
      await productImporter.upsertOne(record);
    } catch (err) {
      await logRowFailure(job, record, err, "product");
    }
  }

  if (syncInventory && inventoryImporter) {
    try {
      await inventoryImporter.syncOne(record);
    } catch (err) {
      await logRowFailure(job, record, err, "inventory");
    }
  }
}

/**
 * @param {import('../jobs/ImportJob.js').ImportJob} job
 * @param {import('../types.js').ProductRecord} record
 * @param {Error} err
 * @param {string} type
 */
async function logRowFailure(job, record, err, type) {
  const entry = {
    sku: record.sku,
    type,
    reason: err?.message || String(err),
    title: record.title,
    category: record.category,
  };
  job.recordFailed(entry);
  await appendFailedEntry(job.resultsDir, entry);
}
