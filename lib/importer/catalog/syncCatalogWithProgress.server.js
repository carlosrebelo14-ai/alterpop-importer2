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
  /** @type {{ shop: string, sku: string, filterId: string }[]} */
  const accumulatedTags = [];
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

  await streamOcioStockRows({
    skipRows: resumeFromScanned,
    onRow: async (rawRow) => {
      scanned += 1;
      audit.totalLinesRead = scanned;

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
        await insertCatalogProductBatch(shop, batch, { accumulatedTags });
        if (!skipSmartRules && inMemoryQueue) {
          await applySmartRulesToBatch(batch, { queue: inMemoryQueue, saveFile: false });
        }
        for (const p of batch) {
          onProduct?.({
            sku: p.sku,
            title: p.title,
            imageUrl: p.imageUrl || null,
            vendor: p.vendor,
            stock: p.stock,
            netPrice: p.netPrice,
          });
        }
        indexed += batch.length;
        batch = [];
        onProgress?.({ indexed, scanned, phase: "streaming" });
        onCheckpoint?.({ indexed, scanned });
      }
    },
  });

  if (batch.length) {
    await insertCatalogProductBatch(shop, batch, { accumulatedTags });
    if (!skipSmartRules && inMemoryQueue) {
      await applySmartRulesToBatch(batch, { queue: inMemoryQueue, saveFile: false });
    }
    for (const p of batch) {
      onProduct?.({
        sku: p.sku,
        title: p.title,
        imageUrl: p.imageUrl || null,
        vendor: p.vendor,
        stock: p.stock,
        netPrice: p.netPrice,
      });
    }
    indexed += batch.length;
  }

  if (accumulatedTags.length) {
    console.log(`[syncCatalog] A gerar e guardar ${accumulatedTags.length} tags de filtro sitemap em lote final...`);
    await bulkInsertCatalogFilterTags(accumulatedTags);
  }

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
    deduplication = await deduplicateCatalog(shop);
    indexed = await getCatalogProductTotal(shop);
    audit.totalImported = indexed;
    audit.deduplication = deduplication;
  }

  const auditSummary = buildAuditSummary(audit);

  onProgress?.({ indexed, scanned, phase: "done", audit: auditSummary, deduplication });

  return { indexed, scanned, facets: index, audit: auditSummary, deduplication };
}
