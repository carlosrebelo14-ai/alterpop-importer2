import fs from "fs/promises";
import path from "path";
import { getDefaultConfig } from "../config.js";
import { mapOcioStockRow } from "../connectors/ociostock/csvFieldMap.js";
import { setActiveCsvColumnMap } from "../connectors/ociostock/csvFieldMap.js";
import { streamOcioStockRows } from "../connectors/ociostock/streamCsv.js";
import { toLiteProduct } from "./catalogProducts.server.js";
import {
  accumulateFacetRow,
  createFacetAccumulator,
  finalizeFacetAccumulator,
} from "./buildFacets.js";
import { translateFacetLabels } from "../transform/translateFacets.js";
import { insertCatalogProductBatch } from "./catalogInsertBatch.server.js";
import {
  createCatalogIndexAudit,
  recordCatalogRejection,
  buildAuditSummary,
} from "./catalogIndexAudit.server.js";
import { deduplicateCatalog } from "./deduplicateCatalog.server.js";
import { getCatalogProductTotal } from "./catalogProductsDb.server.js";

const STREAM_BATCH = 500;
const PROGRESS_LOG_INTERVAL = 1000; // linhas do CSV entre checkpoints de progresso no log

/**
 * Log de checkpoint — só console.log + Date.now() + process.memoryUsage(), sem
 * I/O de disco/rede, para não impactar o throughput da indexação. A taxa é
 * calculada desde o checkpoint ANTERIOR (não desde o início), para conseguirmos
 * ver se desacelera numa janela específica em vez de só a média geral.
 * @param {{ scanned: number, indexed: number, lastAt: number, lastScanned: number }} state
 */
function logProgressCheckpoint(state) {
  const now = Date.now();
  const elapsedMs = now - state.lastAt;
  const deltaScanned = state.scanned - state.lastScanned;
  const rate = elapsedMs > 0 ? Math.round((deltaScanned / elapsedMs) * 1000) : 0;
  const mem = process.memoryUsage();
  const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
  const rssMB = Math.round(mem.rss / 1024 / 1024);
  console.log(
    `[indexing] ${state.scanned} linhas lidas / ${state.indexed} produtos indexados (${rate}/s desde o último checkpoint) — heap=${heapMB}MB rss=${rssMB}MB`
  );
  state.lastAt = now;
  state.lastScanned = state.scanned;
}

// TEMP: remover após diagnóstico do slowdown 25k — timing por sub-fase do batch
/**
 * @param {{ insertMs: number, rulesMs: number, otherMs: number, batchCount: number }} acc
 * @param {number} scanned
 */
function logBatchTiming(acc, scanned) {
  console.log(
    `[indexing:timing] até linha ${scanned} (${acc.batchCount} batches) — insert=${acc.insertMs}ms rules=${acc.rulesMs}ms outros=${acc.otherMs}ms`
  );
}
// FIM TEMP

function indexPath(shop) {
  return path.join(
    getDefaultConfig().paths.data,
    "catalog-index",
    `${shop.replace(/\//g, "_")}.json`
  );
}

/**
 * Uma passagem CSV: facets + SQLite + callbacks de progresso.
 * @param {string} shop
 * @param {object} [settings]
 * @param {{
 *   onProduct?: (product: object) => void,
 *   onProgress?: (stats: { indexed: number, scanned: number, phase: string }) => void,
 *   clearFirst?: boolean,
 *   resumeFromScanned?: number,
 *   onCheckpoint?: (stats: { indexed: number, scanned: number }) => void,
 * }} hooks
 */
export async function syncCatalogWithProgress(shop, settings = {}, hooks = {}) {
  const {
    onProduct,
    onProgress,
    clearFirst = true,
    resumeFromScanned = 0,
    onCheckpoint,
    skipSmartRules = false,
    skipFacetTranslation = false,
    skipDedup = false,
  } = hooks;

  const resume = resumeFromScanned > 0;

  if (settings.ociostockCsvUrl && !process.env.OCIOSTOCK_CSV_PATH) {
    process.env.OCIOSTOCK_CSV_URL = settings.ociostockCsvUrl;
  }
  setActiveCsvColumnMap(settings.csvColumnMap || {});

  const { prisma, safePrisma } = await import("../../prisma/prismaSafe.server.js");
  const { evaluateExcludeList } = await import("../curation/evaluateExcludeList.server.js");
  const { normalizeRecordCategories } = await import("../transform/normalizeCategory.js");
  const { clearExcludeListCache } = await import("../curation/loadExcludeList.server.js");
  const {
    primeMarketSettingsForShop,
    setActiveMarketShop,
  } = await import("../curation/dynamicRules.server.js");
  clearExcludeListCache();
  await primeMarketSettingsForShop(shop);
  setActiveMarketShop(shop);
  const { applySmartRulesToBatch } = await import("./catalogProductsDb.server.js");

  if (clearFirst) {
    onProgress?.({ indexed: 0, scanned: 0, phase: "clearing" });
    await safePrisma("catalog.clear", () =>
      prisma.$transaction([
        prisma.catalogProductFilterTag.deleteMany({ where: { shop } }),
        prisma.catalogProduct.deleteMany({ where: { shop } }),
      ])
    );
  }

  const facetAcc = createFacetAccumulator();
  const audit = createCatalogIndexAudit();
  let indexed = resume ? await getCatalogProductTotal(shop) : 0;
  let scanned = resumeFromScanned;
  if (resume) {
    audit.totalLinesRead = resumeFromScanned;
  }
  /** @type {ReturnType<typeof toLiteProduct>[]} */
  let batch = [];

  const { loadCurationQueue, saveCurationQueue } = await import("../../curation/curationQueue.server.js");
  const { bulkInsertCatalogFilterTags } = await import("./catalogInsertBatch.server.js");
  const inMemoryQueue = !skipSmartRules ? await loadCurationQueue() : null;

  onProgress?.({
    indexed,
    scanned,
    phase: resume ? "resuming" : "streaming",
    resumedFrom: resume ? resumeFromScanned : 0,
  });

  const progressState = { scanned, indexed, lastAt: Date.now(), lastScanned: scanned };
  // TEMP: remover após diagnóstico do slowdown 25k
  const timingAcc = { insertMs: 0, rulesMs: 0, otherMs: 0, batchCount: 0 };
  // FIM TEMP

  await streamOcioStockRows({
    skipRows: resumeFromScanned,
    onRow: async (rawRow) => {
      scanned += 1;
      audit.totalLinesRead = scanned;

      if (scanned % PROGRESS_LOG_INTERVAL === 0) {
        progressState.scanned = scanned;
        progressState.indexed = indexed;
        logProgressCheckpoint(progressState);
        logBatchTiming(timingAcc, scanned); // TEMP: remover após diagnóstico do slowdown 25k
        timingAcc.insertMs = 0; // TEMP
        timingAcc.rulesMs = 0; // TEMP
        timingAcc.otherMs = 0; // TEMP
        timingAcc.batchCount = 0; // TEMP
      }

      const record = mapOcioStockRow(rawRow);
      if (!record?.sku) {
        recordCatalogRejection(audit, "missing_sku");
        return;
      }

      normalizeRecordCategories(record, { sku: record.sku });

      const exclude = evaluateExcludeList(record);
      if (exclude.excluded) {
        recordCatalogRejection(audit, exclude.reason);
        return;
      }
      if (exclude.vipFastTrack) {
        record._structuredTrack = exclude.structuredTrack || exclude.reason;
      }

      accumulateFacetRow(facetAcc, record);
      const lite = toLiteProduct(record);
      batch.push(lite);

      if (batch.length >= STREAM_BATCH) {
        const batchStart = Date.now(); // TEMP: remover após diagnóstico do slowdown 25k

        const insertStart = Date.now(); // TEMP
        await insertCatalogProductBatch(shop, batch);
        const insertElapsed = Date.now() - insertStart; // TEMP

        let rulesElapsed = 0; // TEMP
        if (!skipSmartRules && inMemoryQueue) {
          const rulesStart = Date.now(); // TEMP
          await applySmartRulesToBatch(batch, { queue: inMemoryQueue, saveFile: false });
          rulesElapsed = Date.now() - rulesStart; // TEMP
        }

        indexed += batch.length;
        batch = [];
        onProgress?.({ indexed, scanned, phase: "streaming" });
        onCheckpoint?.({ indexed, scanned });
        // Yield to event loop — let HTTP requests through between batches.
        await new Promise((r) => setImmediate(r));

        // TEMP: remover após diagnóstico do slowdown 25k
        const totalElapsed = Date.now() - batchStart;
        timingAcc.insertMs += insertElapsed;
        timingAcc.rulesMs += rulesElapsed;
        timingAcc.otherMs += Math.max(0, totalElapsed - insertElapsed - rulesElapsed);
        timingAcc.batchCount += 1;
        // FIM TEMP
      }
    },
  });

  if (batch.length) {
    const tailInsertStart = Date.now(); // TEMP: remover após diagnóstico do slowdown 25k
    await insertCatalogProductBatch(shop, batch);
    const tailInsertElapsed = Date.now() - tailInsertStart; // TEMP

    let tailRulesElapsed = 0; // TEMP
    if (!skipSmartRules && inMemoryQueue) {
      const tailRulesStart = Date.now(); // TEMP
      await applySmartRulesToBatch(batch, { queue: inMemoryQueue, saveFile: false });
      tailRulesElapsed = Date.now() - tailRulesStart; // TEMP
    }
    indexed += batch.length;
    console.log(
      `[indexing:timing] batch residual (${batch.length} produtos) — insert=${tailInsertElapsed}ms rules=${tailRulesElapsed}ms`
    ); // TEMP: remover após diagnóstico do slowdown 25k
  }

  // TEMP: remover após diagnóstico do slowdown 25k — última janela, pode não ter batido no checkpoint de 1000
  if (timingAcc.batchCount > 0) {
    logBatchTiming(timingAcc, scanned);
  }
  // FIM TEMP

  if (!skipSmartRules && inMemoryQueue) {
    console.log("[syncCatalog] A guardar a fila de curadoria em disco no final da indexação...");
    await saveCurationQueue(inMemoryQueue);
  }

  onProgress?.({ indexed, scanned, phase: "facets" });
  onCheckpoint?.({ indexed, scanned });

  let facets;
  let facetsEn;
  if (resume && !skipFacetTranslation) {
    const { refreshCatalogIndex } = await import("./catalogIndex.server.js");
    const { ensureLocalOcioStockCsv } = await import("./ensureLocalOcioStockCsv.server.js");
    onProgress?.({ indexed, scanned, phase: "facets-refresh" });
    await ensureLocalOcioStockCsv(shop, settings);
    const refreshed = await refreshCatalogIndex(shop, settings);
    facets = refreshed.facets;
    facetsEn = refreshed.facetsEn;
  } else if (resume && skipFacetTranslation) {
    facets = finalizeFacetAccumulator(facetAcc);
    facetsEn = {
      categoryMain: Object.fromEntries((facets.categoryMain || []).map((k) => [k, k])),
      categorySegments: Object.fromEntries((facets.categorySegments || []).map((k) => [k, k])),
      brands: Object.fromEntries((facets.brands || []).map((b) => [b, b])),
      franchises: { ...(facets.labels?.franchises || {}) },
    };
  } else {
    facets = finalizeFacetAccumulator(facetAcc);
    facetsEn = skipFacetTranslation
    ? {
        categoryMain: Object.fromEntries((facets.categoryMain || []).map((k) => [k, k])),
        categorySegments: Object.fromEntries((facets.categorySegments || []).map((k) => [k, k])),
        brands: Object.fromEntries((facets.brands || []).map((b) => [b, b])),
        franchises: { ...(facets.labels?.franchises || {}) },
      }
      : await translateFacetLabels(facets, settings);
  }

  const index = {
    updatedAt: new Date().toISOString(),
    totalRows: indexed,
    facets,
    facetsEn,
  };

  await fs.mkdir(path.dirname(indexPath(shop)), { recursive: true });
  await fs.writeFile(indexPath(shop), JSON.stringify(index, null, 2));

  const productsLitePath = path.join(
    getDefaultConfig().paths.data,
    "catalog-index",
    `${shop.replace(/\//g, "_")}-products-lite.json`
  );
  await fs.writeFile(
    productsLitePath,
    JSON.stringify({
      updatedAt: index.updatedAt,
      totalRows: indexed,
      products: [],
      dbSynced: true,
    })
  );

  audit.totalImported = indexed;

  let deduplication = null;
  if (!skipDedup) {
    onProgress?.({ indexed, scanned, phase: "deduplicating" });
    const dedupStart = Date.now(); // TEMP: remover após diagnóstico do slowdown 25k
    deduplication = await deduplicateCatalog(shop);
    const dedupElapsed = Date.now() - dedupStart; // TEMP
    console.log(`[indexing:timing] dedup=${dedupElapsed}ms`); // TEMP: remover após diagnóstico do slowdown 25k
    indexed = await getCatalogProductTotal(shop);
    audit.totalImported = indexed;
    audit.deduplication = deduplication;
  }

  const auditSummary = buildAuditSummary(audit);

  onProgress?.({ indexed, scanned, phase: "done", audit: auditSummary, deduplication });

  return { indexed, scanned, facets: index, audit: auditSummary, deduplication };
}
