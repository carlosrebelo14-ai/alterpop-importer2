import { computeCurationSkuFilter } from "./curationStatusFilter.server.js";

/**
 * SKUs que o filtro atual do painel seleciona. Tem de usar EXATAMENTE os mesmos filtros que
 * /api/products usa para mostrar a contagem nos botões "Aprovar/Rejeitar Toda a Pesquisa"
 * (bug de 2026-08-13: "selecionei 135, só aprovou 100") — por isso é partilhado entre a
 * ação em massa e a ação "aplicar aos publicados".
 * @param {string} shop
 * @param {Record<string, any>} [filters]
 * @returns {Promise<string[]>}
 */
export async function resolveFilteredSkus(shop, filters = {}) {
  const { getMatchingCatalogSkus } = await import("../importer/catalog/catalogProductsDb.server.js");
  const { skuInclude, skuExclude } = await computeCurationSkuFilter(filters.curationStatus || null, filters.reason || null);
  return getMatchingCatalogSkus(shop, {
    brand: filters.brand || null,
    search: filters.search || "",
    searchScope: filters.searchScope || "all",
    minPrice: filters.minPrice || "",
    maxPrice: filters.maxPrice || "",
    inStockOnly: filters.inStockOnly,
    filterIds: Array.isArray(filters.filterIds) ? filters.filterIds : [],
    skuInclude,
    skuExclude,
  });
}
