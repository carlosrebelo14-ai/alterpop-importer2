import { prisma, safePrisma } from "../../prisma/prismaSafe.server.js";
import { mapOcioStockRow } from "../connectors/ociostock/csvFieldMap.js";
import { streamOcioStockRows } from "../connectors/ociostock/streamCsv.js";
import { toLiteProduct } from "./catalogProducts.server.js";
import {
  computeFilterTagIdsForProduct,
  expandFilterIdsForQuery,
  getAllSitemapFilterIds,
} from "./sitemapFilters.server.js";
import {
  partitionFacetFilterIds,
  decodeLicenceFilterId,
} from "./facetRegistry.server.js";
import { translateTitleFromGlossary } from "../transform/glossary/translateTitle.js";
import { CONFIDENCE_SCORE_SQL, computeDataConfidenceScore } from "../curation/dataConfidenceScore.js";

const BATCH = 250;
const COUNTS_CACHE_MS = 5 * 60 * 1000;

/** @type {Map<string, { at: number, counts: Record<string, number> }>} */
const filterCountsCache = new Map();

/** @param {string} value */
function vendorNorm(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * @param {string} shop
 * @param {ReturnType<typeof toLiteProduct>[]} chunk
 */
async function insertCatalogProductBatch(shop, chunk) {
  if (!chunk.length) return;

  await safePrisma("catalogProduct.createMany", () =>
    prisma.catalogProduct.createMany({
      data: chunk.map((p) => ({
        shop,
        sku: p.sku,
        title: p.title,
        categoryMain: p.categoryMain || null,
        categorySegments: JSON.stringify(p.categorySegments || []),
        vendor: p.vendor || null,
        vendorNorm: vendorNorm(p.vendor),
        stock: p.stock ?? 0,
        franchises: JSON.stringify(p.franchises || []),
        netPrice: p.netPrice ?? null,
        grossPrice: p.grossPrice ?? null,
        imageUrl: p.imageUrl || null,
        barcode: p.barcode?.trim() || p.sku || null,
        weightKg: p.weightKg ?? null,
        titleSource: p.titleSource ?? null,
        dimensions: p.dimensions ?? null,
        hsCode: p.hsCode ?? null,
      })),
    })
  );

  /** @type {{ shop: string, sku: string, filterId: string }[]} */
  const tagRows = [];
  for (const p of chunk) {
    for (const filterId of computeFilterTagIdsForProduct(p)) {
      tagRows.push({ shop, sku: p.sku, filterId });
    }
  }

  if (tagRows.length) {
    for (let j = 0; j < tagRows.length; j += BATCH) {
      await safePrisma("catalogProductFilterTag.createMany", () =>
        prisma.catalogProductFilterTag.createMany({
          data: tagRows.slice(j, j + BATCH),
        })
      );
    }
  }
}

/** Indexação por stream (createReadStream + readline) — sem buffer de 30k linhas. */
export async function syncCatalogProductsFromStream(shop) {
  await safePrisma("catalog.clear", () =>
    prisma.$transaction([
      prisma.catalogProductFilterTag.deleteMany({ where: { shop } }),
      prisma.catalogProduct.deleteMany({ where: { shop } }),
    ])
  );

  let total = 0;
  /** @type {ReturnType<typeof toLiteProduct>[]} */
  let batch = [];

  const { normalizeRecordCategories } = await import("../transform/normalizeCategory.js");

  await streamOcioStockRows({
    onRow: async (rawRow) => {
      const record = mapOcioStockRow(rawRow);
      if (!record?.sku) return;

      normalizeRecordCategories(record, { sku: record.sku });

      const { evaluateExcludeList } = await import("../curation/evaluateExcludeList.server.js");
      const exclude = evaluateExcludeList(record);
      if (exclude.excluded) return;
      const lite = toLiteProduct(record);
      batch.push(lite);
      if (batch.length >= BATCH) {
        await insertCatalogProductBatch(shop, batch);
        await applySmartRulesToBatch(batch);
        total += batch.length;
        batch = [];
      }
    },
  });

  if (batch.length) {
    await insertCatalogProductBatch(shop, batch);
    await applySmartRulesToBatch(batch);
    total += batch.length;
  }

  filterCountsCache.delete(shop);
  return total;
}

/** @deprecated Prefer syncCatalogProductsFromStream — carrega tudo em RAM */
export async function syncCatalogProductsToDb(shop, records) {
  await safePrisma("catalog.clear", () =>
    prisma.$transaction([
      prisma.catalogProductFilterTag.deleteMany({ where: { shop } }),
      prisma.catalogProduct.deleteMany({ where: { shop } }),
    ])
  );

  const liteProducts = records.map((r) => toLiteProduct(r)).filter((p) => p.sku);
  for (let i = 0; i < liteProducts.length; i += BATCH) {
    await insertCatalogProductBatch(shop, liteProducts.slice(i, i + BATCH));
  }

  filterCountsCache.delete(shop);
  return liteProducts.length;
}

function normalizeImageUrl(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return null;
}

function rowToLite(row) {
  let categorySegments = [];
  let franchises = [];
  try {
    categorySegments = JSON.parse(row.categorySegments || "[]");
  } catch {
    /* ignore */
  }
  try {
    franchises = JSON.parse(row.franchises || "[]");
  } catch {
    /* ignore */
  }

  const netPrice = row.netPrice != null ? Number(row.netPrice) : null;
  const imageUrl =
    normalizeImageUrl(row.imageUrl) ||
    normalizeImageUrl(row.image_url) ||
    null;

  return {
    sku: row.sku,
    // Título vindo do fornecedor já está em inglês final — reprocessá-lo aqui pelo
    // glossário reintroduziria a classe de bugs da cascata (o glossário aplicado sobre
    // o seu próprio tipo de output). Linhas antigas têm titleSource null e mantêm o
    // comportamento anterior.
    title: row.titleSource === "supplier" ? row.title : translateTitleFromGlossary(row.title),
    titleSource: row.titleSource ?? null,
    dimensions: row.dimensions ?? null,
    hsCode: row.hsCode ?? null,
    categoryMain: row.categoryMain || "",
    categorySegments,
    vendor: row.vendor || "",
    stock: row.stock,
    franchises,
    netPrice,
    grossPrice: row.grossPrice != null ? Number(row.grossPrice) : null,
    imageUrl,
    barcode: row.barcode?.trim() || row.sku || null,
    weightKg: row.weightKg != null ? Number(row.weightKg) : null,
  };
}

/** @param {ReturnType<typeof toLiteProduct>[]} batch */
export async function applySmartRulesToBatch(batch, options = {}) {
  const { upsertCurationQueueBatchFromRecords } = await import(
    "../../curation/curationQueue.server.js"
  );
  return upsertCurationQueueBatchFromRecords(batch, options);
}

function appendPriceWhere(where, params, minPrice, maxPrice) {
  if (minPrice != null && Number.isFinite(minPrice)) {
    where.push("p.netPrice >= ?");
    params.push(minPrice);
  }
  if (maxPrice != null && Number.isFinite(maxPrice)) {
    where.push("p.netPrice <= ?");
    params.push(maxPrice);
  }
}

/** @param {string[]} where */
function appendInStockWhere(where, inStockOnly) {
  if (inStockOnly) {
    where.push("p.stock > 0");
  }
}
/**
 * Cláusula SQL de pesquisa, com âmbito opcional (por defeito procura em sku+title).
 * @param {string} search
 * @param {"all"|"title"|"sku"|"barcode"|"vendor"} [scope]
 * @returns {{ sql: string, params: string[] }}
 */
function buildSearchSqlClause(search, scope) {
  const term = `%${search}%`;
  switch (scope) {
    case "title":
      return { sql: "p.title LIKE ?", params: [term] };
    case "sku":
      return { sql: "p.sku LIKE ?", params: [term] };
    case "barcode":
      return { sql: "p.barcode LIKE ?", params: [term] };
    case "vendor":
      return { sql: "p.vendor LIKE ?", params: [term] };
    default:
      return { sql: "(p.sku LIKE ? OR p.title LIKE ?)", params: [term, term] };
  }
}

/**
 * Equivalente Prisma de buildSearchSqlClause, para o caminho sem tags/licenças.
 * @param {string} search
 * @param {"all"|"title"|"sku"|"barcode"|"vendor"} [scope]
 */
function buildSearchPrismaWhere(search, scope) {
  switch (scope) {
    case "title":
      return { title: { contains: search } };
    case "sku":
      return { sku: { contains: search } };
    case "barcode":
      return { barcode: { contains: search } };
    case "vendor":
      return { vendor: { contains: search } };
    default:
      return { OR: [{ sku: { contains: search } }, { title: { contains: search } }] };
  }
}

// Filtros como "Sem decisão" (curationStatus=NO_DECISION) excluem milhares de SKUs
// já decididos — um só "NOT IN" com isso tudo excede o limite de parâmetros do
// SQLite e rebenta a query. Dividido em blocos, AND'ados entre si — semanticamente
// idêntico a um único NOT IN gigante (bug encontrado 2026-08-13).
const SKU_FILTER_CHUNK_SIZE = 500;

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function appendSkuFilterWhere(where, params, skuInclude, skuExclude) {
  if (skuInclude && Array.isArray(skuInclude)) {
    if (skuInclude.length === 0) {
      where.push("1 = 0");
    } else {
      where.push(`p.sku IN (${skuInclude.map(() => "?").join(",")})`);
      params.push(...skuInclude);
    }
  }
  if (skuExclude && Array.isArray(skuExclude) && skuExclude.length > 0) {
    for (const chunk of chunkArray(skuExclude, SKU_FILTER_CHUNK_SIZE)) {
      where.push(`p.sku NOT IN (${chunk.map(() => "?").join(",")})`);
      params.push(...chunk);
    }
  }
}

function getPrismaOrderBy(sortBy, sortDir) {
  const dir = String(sortDir).toLowerCase() === "desc" ? "desc" : "asc";
  switch (sortBy) {
    case "netPrice": return [{ netPrice: dir }, { sku: "asc" }];
    case "stock": return [{ stock: dir }, { sku: "asc" }];
    case "title": return [{ title: dir }, { sku: "asc" }];
    case "indexedAt": return [{ indexedAt: dir }, { sku: "asc" }];
    default: return [{ sku: "asc" }];
  }
}

function getSqlOrderBy(sortBy, sortDir) {
  const dir = String(sortDir).toLowerCase() === "desc" ? "DESC" : "ASC";
  switch (sortBy) {
    case "netPrice": return `p.netPrice ${dir}, p.sku ASC`;
    case "stock": return `p.stock ${dir}, p.sku ASC`;
    case "title": return `p.title ${dir}, p.sku ASC`;
    case "indexedAt": return `p.indexedAt ${dir}, p.sku ASC`;
    case "margin":
      return `(CASE WHEN p.grossPrice IS NOT NULL AND p.grossPrice > 0 AND p.netPrice IS NOT NULL THEN ((p.grossPrice - p.netPrice) / p.grossPrice) ELSE -999 END) ${dir}, p.sku ASC`;
    case "confidence":
      return `${CONFIDENCE_SCORE_SQL} ${dir}, p.sku ASC`;
    default: return `p.sku ASC`;
  }
}

/** @param {string[]} where @param {number[]} params */
function appendConfidenceWhere(where, params, minConfidence) {
  if (minConfidence != null && Number.isFinite(minConfidence)) {
    where.push(`${CONFIDENCE_SCORE_SQL} >= ?`);
    params.push(minConfidence);
  }
}


/** @param {unknown} value */
export function parseInStockOnlyParam(value) {
  return value === true || value === 1 || value === "1" || value === "true" || value === "on";
}

function buildPrismaWhere(shop, { brand, search, searchScope, minPrice, maxPrice, inStockOnly, skuInclude, skuExclude }) {
  /** @type {import('@prisma/client').Prisma.CatalogProductWhereInput} */
  const where = { shop };
  if (brand) where.vendorNorm = brand;
  if (search) {
    Object.assign(where, buildSearchPrismaWhere(search, searchScope));
  }
  if (inStockOnly) {
    where.stock = { gt: 0 };
  }
  if (
    (minPrice != null && Number.isFinite(minPrice)) ||
    (maxPrice != null && Number.isFinite(maxPrice))
  ) {
    where.netPrice = {};
    if (minPrice != null && Number.isFinite(minPrice)) where.netPrice.gte = minPrice;
    if (maxPrice != null && Number.isFinite(maxPrice)) where.netPrice.lte = maxPrice;
  }
  if (skuInclude && Array.isArray(skuInclude)) {
    where.sku = { ...where.sku, in: skuInclude };
  }
  if (skuExclude && Array.isArray(skuExclude) && skuExclude.length > 0) {
    // Um único notIn gigante (ex: "Sem decisão" excluindo milhares de SKUs já
    // decididos) faz o Prisma recusar-se a dividir a query (negação não é
    // divisível em OR) e rebenta no limite de parâmetros do SQLite. Dividido em
    // blocos AND'ados — mesma semântica, sem o limite (bug encontrado 2026-08-13).
    where.AND = [
      ...(where.AND || []),
      ...chunkArray(skuExclude, SKU_FILTER_CHUNK_SIZE).map((chunk) => ({ sku: { notIn: chunk } })),
    ];
  }
  return where;
}

/**
 * Paginação Prisma skip/take (sem filtros de taxonomia).
 */
async function queryProductsPrismaPaginated(shop, opts) {
  const page = Math.max(1, parseInt(String(opts.page || 1), 10) || 1);
  const limit = Math.min(10000, Math.max(1, parseInt(String(opts.limit || 50), 10) || 50));
  const skip = (page - 1) * limit;
  const brand = opts.brand ? vendorNorm(opts.brand) : null;
  const search = opts.search?.trim() || "";
  const searchScope = opts.searchScope || "all";
  const minPrice = parsePriceParam(opts.minPrice);
  const maxPrice = parsePriceParam(opts.maxPrice);
  const inStockOnly = parseInStockOnlyParam(opts.inStockOnly);

  const minConfidence = parsePriceParam(opts.minConfidence);

  // "margin"/"confidence" são campos calculados — o Prisma não os expressa em orderBy,
  // por isso caem sempre no caminho SQL puro. minConfidence idem: é um WHERE calculado,
  // não representável no objeto `where` do Prisma usado no ramo por baixo.
  if (opts.sortBy === "margin" || opts.sortBy === "confidence" || minConfidence != null) {
    const sqlWhere = ["p.shop = ?"];
    const params = [shop];
    if (brand) { sqlWhere.push("p.vendorNorm = ?"); params.push(brand); }
    if (search) {
      const clause = buildSearchSqlClause(search, searchScope);
      sqlWhere.push(clause.sql);
      params.push(...clause.params);
    }
    appendPriceWhere(sqlWhere, params, minPrice, maxPrice);
    appendInStockWhere(sqlWhere, inStockOnly);
    appendConfidenceWhere(sqlWhere, params, minConfidence);
    appendSkuFilterWhere(sqlWhere, params, opts.skuInclude, opts.skuExclude);
    const whereSql = sqlWhere.join(" AND ");

    const countRows = await safePrisma("catalog.query.count", () =>
      prisma.$queryRawUnsafe(`SELECT COUNT(p.sku) as c FROM CatalogProduct p WHERE ${whereSql}`, ...params)
    );
    const totalCount = Number(countRows[0]?.c) || 0;

    const orderBySql = opts.sortBy === "confidence" || opts.sortBy === "margin"
      ? getSqlOrderBy(opts.sortBy, opts.sortDir)
      : "p.sku ASC";
    const dataRows = await safePrisma("catalog.query.page", () =>
      prisma.$queryRawUnsafe(
        `SELECT p.shop, p.sku, p.title, p.categoryMain, p.categorySegments, p.vendor, p.stock, p.franchises, p.netPrice, p.grossPrice, p.imageUrl, p.barcode, p.titleSource, p.dimensions, p.hsCode, p.weightKg
         FROM CatalogProduct p
         WHERE ${whereSql}
         ORDER BY ${orderBySql}
         LIMIT ? OFFSET ?`,
        ...params,
        limit,
        skip
      )
    );

    return {
      products: dataRows.map(rowToLite),
      page,
      limit,
      totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / limit) || 1),
    };
  }

  const where = buildPrismaWhere(shop, { brand, search, searchScope, minPrice, maxPrice, inStockOnly, skuInclude: opts.skuInclude, skuExclude: opts.skuExclude });

  console.log("[debug:curation] Query executada:", {
    mode: "prisma",
    shop,
    page,
    limit,
    skip,
    filterIds: [],
    brand,
    search: search || null,
    minPrice,
    maxPrice,
    inStockOnly,
    where,
  });

  const [rows, totalCount] = await Promise.all([
    safePrisma("catalogProduct.findMany", () =>
      prisma.catalogProduct.findMany({
        where,
        skip,
        take: limit,
        orderBy: getPrismaOrderBy(opts.sortBy, opts.sortDir),
      })
    ),
    safePrisma("catalogProduct.count", () => prisma.catalogProduct.count({ where }), {
      fallback: 0,
    }),
  ]);

  return {
    products: rows.map(rowToLite),
    page,
    limit,
    totalCount,
    totalPages: Math.max(1, Math.ceil(totalCount / limit) || 1),
  };
}

/**
 * Paginação com JOIN em tags (secção principal → sub-tags via taxonomy-map).
 */
async function queryProductsWithFilterTags(shop, opts) {
  const page = Math.max(1, parseInt(String(opts.page || 1), 10) || 1);
  const limit = Math.min(10000, Math.max(1, parseInt(String(opts.limit || 50), 10) || 50));
  const skip = (page - 1) * limit;
  const filterIds = expandFilterIdsForQuery(opts.filterIds || []);
  const brand = opts.brand ? vendorNorm(opts.brand) : null;
  const search = opts.search?.trim() || "";
  const searchScope = opts.searchScope || "all";
  const minPrice = parsePriceParam(opts.minPrice);
  const maxPrice = parsePriceParam(opts.maxPrice);
  const inStockOnly = parseInStockOnlyParam(opts.inStockOnly);

  const join = `INNER JOIN CatalogProductFilterTag t ON t.shop = p.shop AND t.sku = p.sku`;
  const where = ["p.shop = ?"];
  const params = [shop];

  where.push(`t.filterId IN (${filterIds.map(() => "?").join(",")})`);
  params.push(...filterIds);

  if (brand) {
    where.push("p.vendorNorm = ?");
    params.push(brand);
  }
  if (search) {
    const clause = buildSearchSqlClause(search, searchScope);
    where.push(clause.sql);
    params.push(...clause.params);
  }
  appendPriceWhere(where, params, minPrice, maxPrice);
  appendInStockWhere(where, inStockOnly);
  appendConfidenceWhere(where, params, parsePriceParam(opts.minConfidence));
  appendSkuFilterWhere(where, params, opts.skuInclude, opts.skuExclude);

  const whereSql = where.join(" AND ");

  const queryDebug = {
    mode: "filterTags",
    shop,
    page,
    limit,
    skip,
    filterIds,
    brand,
    search: search || null,
    minPrice,
    maxPrice,
    inStockOnly,
    whereSql,
    paramsCount: params.length,
  };
  console.log("[debug:curation] Query executada:", queryDebug);

  const countRows = await safePrisma("catalog.query.count", () =>
    prisma.$queryRawUnsafe(
      `SELECT COUNT(DISTINCT p.sku) as c FROM CatalogProduct p ${join} WHERE ${whereSql}`,
      ...params
    )
  );
  const totalCount = Number(countRows[0]?.c) || 0;

  const dataRows = await safePrisma("catalog.query.page", () =>
    prisma.$queryRawUnsafe(
      `SELECT DISTINCT p.shop, p.sku, p.title, p.categoryMain, p.categorySegments, p.vendor, p.stock, p.franchises, p.netPrice, p.grossPrice, p.imageUrl, p.barcode, p.titleSource, p.dimensions, p.hsCode, p.weightKg
       FROM CatalogProduct p ${join}
       WHERE ${whereSql}
       ORDER BY ${getSqlOrderBy(opts.sortBy, opts.sortDir)}
       LIMIT ? OFFSET ?`,
      ...params,
      limit,
      skip
    )
  );

  return {
    products: dataRows.map(rowToLite),
    page,
    limit,
    totalCount,
    totalPages: Math.max(1, Math.ceil(totalCount / limit) || 1),
  };
}

/** @param {string} licenceFilterId */
function licenceFranchiseLikePatterns(licenceFilterId) {
  const decoded = decodeLicenceFilterId(licenceFilterId);
  if (!decoded) return ["%"];
  const upper = decoded.toUpperCase();
  const underscored = upper.replace(/\s+/g, "_");
  return [...new Set([`%${decoded}%`, `%${upper}%`, `%${underscored}%`])];
}

/**
 * Filtro por franchises (JSON) — licenças sem reindex de tags.
 */
async function queryProductsWithLicenceFilters(shop, opts) {
  const page = Math.max(1, parseInt(String(opts.page || 1), 10) || 1);
  const limit = Math.min(10000, Math.max(1, parseInt(String(opts.limit || 50), 10) || 50));
  const skip = (page - 1) * limit;
  const licenceIds = opts.licenceIds || [];
  const brand = opts.brand ? vendorNorm(opts.brand) : null;
  const search = opts.search?.trim() || "";
  const searchScope = opts.searchScope || "all";
  const minPrice = parsePriceParam(opts.minPrice);
  const maxPrice = parsePriceParam(opts.maxPrice);
  const inStockOnly = parseInStockOnlyParam(opts.inStockOnly);

  const where = ["p.shop = ?"];
  const params = [shop];

  const licenceClauses = [];
  for (const licId of licenceIds) {
    const patterns = licenceFranchiseLikePatterns(licId);
    const sub = patterns.map(() => "p.franchises LIKE ?").join(" OR ");
    licenceClauses.push(`(${sub})`);
    params.push(...patterns);
  }
  if (licenceClauses.length) {
    where.push(`(${licenceClauses.join(" OR ")})`);
  }

  if (brand) {
    where.push("p.vendorNorm = ?");
    params.push(brand);
  }
  if (search) {
    const clause = buildSearchSqlClause(search, searchScope);
    where.push(clause.sql);
    params.push(...clause.params);
  }
  appendPriceWhere(where, params, minPrice, maxPrice);
  appendInStockWhere(where, inStockOnly);
  appendConfidenceWhere(where, params, parsePriceParam(opts.minConfidence));
  appendSkuFilterWhere(where, params, opts.skuInclude, opts.skuExclude);

  const whereSql = where.join(" AND ");

  const countRows = await safePrisma("catalog.licence.count", () =>
    prisma.$queryRawUnsafe(
      `SELECT COUNT(DISTINCT p.sku) as c FROM CatalogProduct p WHERE ${whereSql}`,
      ...params
    )
  );
  const totalCount = Number(countRows[0]?.c) || 0;

  const dataRows = await safePrisma("catalog.licence.page", () =>
    prisma.$queryRawUnsafe(
      `SELECT DISTINCT p.shop, p.sku, p.title, p.categoryMain, p.categorySegments, p.vendor, p.stock, p.franchises, p.netPrice, p.grossPrice, p.imageUrl, p.barcode, p.titleSource, p.dimensions, p.hsCode, p.weightKg
       FROM CatalogProduct p
       WHERE ${whereSql}
       ORDER BY ${getSqlOrderBy(opts.sortBy, opts.sortDir)}
       LIMIT ? OFFSET ?`,
      ...params,
      limit,
      skip
    )
  );

  return {
    products: dataRows.map(rowToLite),
    page,
    limit,
    totalCount,
    totalPages: Math.max(1, Math.ceil(totalCount / limit) || 1),
  };
}

/**
 * Licenças (franchises) + tipos de produto (tags).
 */
async function queryProductsWithCombinedFacets(shop, opts) {
  const page = Math.max(1, parseInt(String(opts.page || 1), 10) || 1);
  const limit = Math.min(10000, Math.max(1, parseInt(String(opts.limit || 50), 10) || 50));
  const skip = (page - 1) * limit;
  const licenceIds = opts.licenceIds || [];
  const filterIds = opts.productTypeIds || [];
  const brand = opts.brand ? vendorNorm(opts.brand) : null;
  const search = opts.search?.trim() || "";
  const searchScope = opts.searchScope || "all";
  const minPrice = parsePriceParam(opts.minPrice);
  const maxPrice = parsePriceParam(opts.maxPrice);
  const inStockOnly = parseInStockOnlyParam(opts.inStockOnly);

  const join = `INNER JOIN CatalogProductFilterTag t ON t.shop = p.shop AND t.sku = p.sku`;
  const where = ["p.shop = ?"];
  const params = [shop];

  where.push(`t.filterId IN (${filterIds.map(() => "?").join(",")})`);
  params.push(...filterIds);

  const licenceClauses = [];
  for (const licId of licenceIds) {
    const patterns = licenceFranchiseLikePatterns(licId);
    const sub = patterns.map(() => "p.franchises LIKE ?").join(" OR ");
    licenceClauses.push(`(${sub})`);
    params.push(...patterns);
  }
  if (licenceClauses.length) {
    where.push(`(${licenceClauses.join(" OR ")})`);
  }

  if (brand) {
    where.push("p.vendorNorm = ?");
    params.push(brand);
  }
  if (search) {
    const clause = buildSearchSqlClause(search, searchScope);
    where.push(clause.sql);
    params.push(...clause.params);
  }
  appendPriceWhere(where, params, minPrice, maxPrice);
  appendInStockWhere(where, inStockOnly);
  appendConfidenceWhere(where, params, parsePriceParam(opts.minConfidence));
  appendSkuFilterWhere(where, params, opts.skuInclude, opts.skuExclude);

  const whereSql = where.join(" AND ");

  const countRows = await safePrisma("catalog.combined.count", () =>
    prisma.$queryRawUnsafe(
      `SELECT COUNT(DISTINCT p.sku) as c FROM CatalogProduct p ${join} WHERE ${whereSql}`,
      ...params
    )
  );
  const totalCount = Number(countRows[0]?.c) || 0;

  const dataRows = await safePrisma("catalog.combined.page", () =>
    prisma.$queryRawUnsafe(
      `SELECT DISTINCT p.shop, p.sku, p.title, p.categoryMain, p.categorySegments, p.vendor, p.stock, p.franchises, p.netPrice, p.grossPrice, p.imageUrl, p.barcode, p.titleSource, p.dimensions, p.hsCode, p.weightKg
       FROM CatalogProduct p ${join}
       WHERE ${whereSql}
       ORDER BY ${getSqlOrderBy(opts.sortBy, opts.sortDir)}
       LIMIT ? OFFSET ?`,
      ...params,
      limit,
      skip
    )
  );

  return {
    products: dataRows.map(rowToLite),
    page,
    limit,
    totalCount,
    totalPages: Math.max(1, Math.ceil(totalCount / limit) || 1),
  };
}

async function queryProductsPaginated(shop, opts) {
  const expanded = expandFilterIdsForQuery(opts.filterIds || []);
  const { licenceIds, productTypeIds } = partitionFacetFilterIds(expanded);

  if (licenceIds.length === 0 && productTypeIds.length === 0) {
    return queryProductsPrismaPaginated(shop, opts);
  }
  if (licenceIds.length > 0 && productTypeIds.length === 0) {
    return queryProductsWithLicenceFilters(shop, { ...opts, licenceIds });
  }
  if (productTypeIds.length > 0 && licenceIds.length === 0) {
    return queryProductsWithFilterTags(shop, { ...opts, filterIds: productTypeIds });
  }
  return queryProductsWithCombinedFacets(shop, {
    ...opts,
    licenceIds,
    productTypeIds,
  });
}

/**
 * Devolve todos os SKUs que correspondem aos filtros atuais (sem limite de página).
 * @param {string} shop
 * @param {object} opts
 * @returns {Promise<string[]>}
 */
export async function getMatchingCatalogSkus(shop, opts = {}) {
  // Limite máximo de segurança: 10,000 SKUs de uma só vez
  const result = await queryProductsPaginated(shop, { ...opts, page: 1, limit: 10000 });
  return (result.products || []).map((p) => p.sku).filter(Boolean);
}

function parsePriceParam(value) {
  if (value == null || value === "") return null;
  const n = parseFloat(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export async function queryCatalogProducts(shop, opts = {}) {
  const includeCounts = opts.includeCounts === true;
  const result = await queryProductsPaginated(shop, opts);

  const { computeTargetRetailPrice } = await import("../pricing/targetRetail.server.js");
  const skus = (result.products || []).map((p) => p.sku).filter(Boolean);
  const [{ getSyncErrorsBySkus }, { getSalesBySkus }] = await Promise.all([
    import("../sync/syncErrorLog.server.js"),
    import("../shopify/salesRadar.server.js"),
  ]);
  const [errorMap, salesMap] = await Promise.all([
    getSyncErrorsBySkus(shop, skus),
    getSalesBySkus(shop, skus),
  ]);

  result.products = (result.products || []).map((p) => ({
    ...p,
    targetRetailPrice: computeTargetRetailPrice(p.netPrice),
    syncError: errorMap[p.sku] || null,
    salesUnits30d: salesMap[p.sku] ?? null,
    dataConfidence: computeDataConfidenceScore(p),
  }));

  if (includeCounts) {
    result.filterCounts = await getSitemapFilterCounts(shop, opts.brand || null);
  }

  return result;
}

export async function getSitemapFilterCounts(shop, brand = null) {
  const cacheKey = `${shop}::${brand || ""}`;
  const cached = filterCountsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < COUNTS_CACHE_MS) {
    return cached.counts;
  }

  const ids = getAllSitemapFilterIds();
  const counts = Object.fromEntries(ids.map((id) => [id, 0]));

  if (!brand) {
    const groups = await safePrisma("catalog.filterTag.groupBy", () =>
      prisma.catalogProductFilterTag.groupBy({
        by: ["filterId"],
        where: { shop },
        _count: { filterId: true },
      })
    );
    for (const g of groups) {
      counts[g.filterId] = g._count.filterId;
    }
  } else {
    const vn = vendorNorm(brand);
    const rows = await safePrisma("catalog.filterTag.byBrand", () =>
      prisma.$queryRawUnsafe(
        `SELECT t.filterId as filterId, COUNT(*) as c
       FROM CatalogProductFilterTag t
       INNER JOIN CatalogProduct p ON p.shop = t.shop AND p.sku = t.sku
       WHERE t.shop = ? AND p.vendorNorm = ?
       GROUP BY t.filterId`,
        shop,
        vn
      )
    );
    for (const row of rows) {
      counts[row.filterId] = Number(row.c) || 0;
    }
  }

  filterCountsCache.set(cacheKey, { at: Date.now(), counts });
  return counts;
}

export async function getCatalogProductTotal(shop) {
  if (!prisma?.catalogProduct?.count) {
    return 0;
  }
  return safePrisma("catalogProduct.count", () =>
    prisma.catalogProduct.count({ where: { shop } }),
    { fallback: 0 }
  );
}
