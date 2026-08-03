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
const CURATION_FLUSH_INTERVAL = PROGRESS_LOG_INTERVAL * 5; // linhas entre flushes da curation queue a disco

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

  const { loadCurationQueue, flushCurationQueueItems } = await import(
    "../../curation/curationQueue.server.js"
  );
  const { bulkInsertCatalogFilterTags } = await import("./catalogInsertBatch.server.js");
  const inMemoryQueue = !skipSmartRules ? await loadCurationQueue() : null;

  // Limite entre os itens já existentes no disco no arranque (preservados em memória
  // durante toda a run, para a lógica de merge de decisões manuais continuar a funcionar)
  // e os itens novos/atualizados nesta run (que são periodicamente esvaziados para disco).
  const curationOriginalLength = inMemoryQueue ? inMemoryQueue.items.length : 0;
  // Itens ORIGINAIS (índice < curationOriginalLength) que foram mutados nesta run — têm de
  // ser incluídos no próximo flush porque splice() só retira os itens novos (índice >= limite).
  const curationDirtyOriginals = new Map();

  /**
   * Regista quais dos itens da queue foram tocados por este batch (novos ou merges
   * sobre entradas pré-existentes), para depois serem incluídos no flush periódico.
   * @param {{ sku: string }[]} batchRecords
   */
  function trackCurationTouches(batchRecords) {
    if (!inMemoryQueue?._bySku) return;
    for (const record of batchRecords) {
      const entry = inMemoryQueue._bySku.get(record.sku);
      if (entry && entry.index < curationOriginalLength) {
        curationDirtyOriginals.set(record.sku, entry.item);
      }
    }
  }

  /**
   * Esvazia para disco os itens da curation queue acumulados desde o último flush
   * (novos desta run + originais mutados) e liberta as referências em memória.
   */
  async function flushCurationQueueWindow() {
    if (!inMemoryQueue) return;
    const pending = inMemoryQueue.items.splice(curationOriginalLength);
    if (inMemoryQueue._bySku) {
      for (const item of pending) inMemoryQueue._bySku.delete(item.sku);
    }
    for (const item of curationDirtyOriginals.values()) pending.push(item);
    curationDirtyOriginals.clear();
    if (pending.length) {
      await flushCurationQueueItems(pending);
    }
  }

  onProgress?.({
    indexed,
    scanned,
    phase: resume ? "resuming" : "streaming",
    resumedFrom: resume ? resumeFromScanned : 0,
  });

  const progressState = { scanned, indexed, lastAt: Date.now(), lastScanned: scanned };

  await streamOcioStockRows({
    skipRows: resumeFromScanned,
    onRow: async (rawRow) => {
      scanned += 1;
      audit.totalLinesRead = scanned;

      if (scanned % PROGRESS_LOG_INTERVAL === 0) {
        progressState.scanned = scanned;
        progressState.indexed = indexed;
        logProgressCheckpoint(progressState);

        if (!skipSmartRules && inMemoryQueue && scanned % CURATION_FLUSH_INTERVAL === 0) {
          await flushCurationQueueWindow();
        }
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
        await insertCatalogProductBatch(shop, batch);

        if (!skipSmartRules && inMemoryQueue) {
          await applySmartRulesToBatch(batch, { queue: inMemoryQueue, saveFile: false });
          trackCurationTouches(batch);
        }

        indexed += batch.length;
        batch = [];
        onProgress?.({ indexed, scanned, phase: "streaming" });
        onCheckpoint?.({ indexed, scanned });
        // Yield to event loop — let HTTP requests through between batches.
        await new Promise((r) => setImmediate(r));
      }
    },
  });

  if (batch.length) {
    await insertCatalogProductBatch(shop, batch);

    if (!skipSmartRules && inMemoryQueue) {
      await applySmartRulesToBatch(batch, { queue: inMemoryQueue, saveFile: false });
      trackCurationTouches(batch);
    }
    indexed += batch.length;
  }

  if (!skipSmartRules && inMemoryQueue) {
    console.log("[syncCatalog] A guardar a fila de curadoria em disco (flush final)...");
    await flushCurationQueueWindow();
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
    deduplication = await deduplicateCatalog(shop);
    indexed = await getCatalogProductTotal(shop);
    audit.totalImported = indexed;
    audit.deduplication = deduplication;
  }

  const auditSummary = buildAuditSummary(audit);

  onProgress?.({ indexed, scanned, phase: "done", audit: auditSummary, deduplication });

  return { indexed, scanned, facets: index, audit: auditSummary, deduplication };
}
