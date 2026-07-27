import { translateTextCached } from "./translate.js";
import { resolveTranslationConfig } from "./translationConfig.js";
import { humanizeFranchiseRef } from "../connectors/ociostock/parseFamilies.js";

/**
 * Build EN display labels for facet values (UI filters).
 * @param {object} facets from buildCatalogFacets
 * @param {object} settings
 */
export async function translateFacetLabels(facets, settings = {}) {
  const { translateToEnglish, provider } = resolveTranslationConfig(settings);

  const labels = {
    categoryMain: {},
    categorySegments: {},
    brands: { ...Object.fromEntries((facets.brands || []).map((b) => [b, b])) },
    franchises: { ...(facets.labels?.franchises || {}) },
  };

  if (!translateToEnglish || provider === "passthrough") {
    for (const k of facets.categoryMain || []) labels.categoryMain[k] = k;
    for (const k of facets.categorySegments || []) labels.categorySegments[k] = k;
    for (const f of facets.franchises || []) {
      labels.franchises[f] = labels.franchises[f] || humanizeFranchiseRef(f);
    }
    return labels;
  }

  for (const k of facets.categoryMain || []) {
    labels.categoryMain[k] = await translateTextCached(k, "categoryMain");
  }
  for (const k of facets.categorySegments || []) {
    labels.categorySegments[k] = await translateTextCached(k, "categorySegments");
  }
  for (const f of facets.franchises || []) {
    if (!labels.franchises[f]) {
      labels.franchises[f] = await translateTextCached(humanizeFranchiseRef(f), "franchise");
    }
  }

  return labels;
}
