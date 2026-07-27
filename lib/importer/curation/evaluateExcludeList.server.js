import { evaluateStructuredCatalogFilter } from "./structuredCatalogFilter.server.js";

/**
 * Filtro de importação — delega para campos estruturados pós csvFieldMap
 * (categoryMain, categorySegments, productTypePath, franchises/tags).
 *
 * @param {import('../types.js').ProductRecord} record
 * @returns {{ excluded: boolean, reason?: string, vipFastTrack?: boolean, structuredTrack?: string }}
 */
export function evaluateExcludeList(record) {
  const result = evaluateStructuredCatalogFilter(record);

  return {
    excluded: result.excluded,
    reason: result.reason,
    vipFastTrack: result.fastTrack === true,
    structuredTrack: result.track || undefined,
  };
}
