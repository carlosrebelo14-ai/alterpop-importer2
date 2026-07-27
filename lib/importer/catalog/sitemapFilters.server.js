/**
 * Filtros sitemap (servidor) — taxonomy-map.json.
 */
export {
  getTaxonomySectionsForUi,
  getAllTaxonomyFilterIds as getAllSitemapFilterIds,
  getTaxonomySectionIds,
  expandFilterIdsForQuery,
  computeTaxonomyFilterTagIds as computeFilterTagIdsForProduct,
  buildTaxonomyMatcherMap as buildFilterMatcherMap,
} from "./taxonomy.server.js";
