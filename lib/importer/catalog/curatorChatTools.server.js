import { queryCatalogProducts } from "./catalogProductsDb.server.js";
import { getCatalogProductTotal } from "./catalogProductsDb.server.js";
import { resolveCatalogUiFilters } from "./resolveCatalogUiFilters.server.js";

/**
 * @param {string} shop
 * @param {Record<string, unknown>} args
 */
export async function executeSearchProducts(shop, args) {
  const limit = Math.min(20, Math.max(1, Number(args.limit) || 10));
  const page = Math.max(1, Number(args.page) || 1);

  const resolved = await resolveCatalogUiFilters(shop, {
    brand: args.brand,
    search: args.search,
    licence: args.licence || args.franchise,
    productType: args.productType,
    minPrice: args.minPrice,
    maxPrice: args.maxPrice,
    inStockOnly: args.inStockOnly,
  });

  const { uiFilters } = resolved;
  const filterIds = [...uiFilters.licenceIds, ...uiFilters.productTypeIds];

  const result = await queryCatalogProducts(shop, {
    page,
    limit,
    brand: uiFilters.brand,
    search: uiFilters.search,
    minPrice: uiFilters.minPrice || null,
    maxPrice: uiFilters.maxPrice || null,
    inStockOnly: uiFilters.inStockOnly,
    filterIds,
  });

  return {
    totalCount: result.totalCount,
    page: result.page,
    limit: result.limit,
    uiFilters,
    products: (result.products || []).map((p) => ({
      sku: p.sku,
      title: p.title,
      brand: p.vendor,
      category: p.categoryMain,
      netPrice: p.netPrice,
      targetRetail: p.targetRetailPrice,
      stock: p.stock,
      sales30d: p.salesUnits30d ?? null,
    })),
  };
}

/**
 * Aplica filtros ao painel principal do dashboard (não só texto no chat).
 * @param {string} shop
 * @param {Record<string, unknown>} args
 */
export async function executeApplyCatalogFilters(shop, args) {
  const resolved = await resolveCatalogUiFilters(shop, args);
  return {
    applied: true,
    totalCount: resolved.totalCount,
    uiFilters: resolved.uiFilters,
    labels: resolved.labels,
    filterSummary: resolved.filterSummary,
    previewProducts: resolved.previewProducts,
    message: `Filters applied. ${resolved.totalCount} product(s) match in the catalog panel.`,
  };
}

/**
 * @param {string} shop
 */
export async function executeGetCatalogSummary(shop) {
  const total = await getCatalogProductTotal(shop);
  return { totalProducts: total, shop };
}

/**
 * @param {string} shop
 * @param {string} name
 * @param {Record<string, unknown>} args
 */
export async function executeCuratorTool(shop, name, args) {
  if (name === "apply_catalog_filters") {
    return executeApplyCatalogFilters(shop, args);
  }
  if (name === "search_products") {
    return executeSearchProducts(shop, args);
  }
  if (name === "get_catalog_summary") {
    return executeGetCatalogSummary(shop);
  }
  return { error: `Unknown tool: ${name}` };
}
