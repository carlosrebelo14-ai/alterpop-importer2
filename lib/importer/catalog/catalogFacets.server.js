import fs from "fs/promises";
import path from "path";
import { getDefaultConfig } from "../config.js";
import {
  getProductTypeFacetsForUi,
  licenceFilterId,
  toEnglishFacetLabel,
  shouldShowLicenceFacet,
} from "./facetRegistry.server.js";
import { getSitemapFilterCounts } from "./catalogProductsDb.server.js";

function catalogIndexPath(shop) {
  return path.join(
    getDefaultConfig().paths.data,
    "catalog-index",
    `${shop.replace(/\//g, "_")}.json`
  );
}

/**
 * @param {string} shop
 */
export async function getCatalogFacetsForUi(shop) {
  const productTypeDefs = getProductTypeFacetsForUi();
  const filterCounts = await getSitemapFilterCounts(shop, null);

  const productTypes = productTypeDefs
    .map((pt) => ({
      id: pt.id,
      label: pt.label,
      count: filterCounts[pt.id] || 0,
    }))
    .filter((pt) => pt.count > 0)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "en"));

  let licences = [];
  let brands = [];
  try {
    const raw = await fs.readFile(catalogIndexPath(shop), "utf8");
    const index = JSON.parse(raw);
    const facets = index.facets || {};
    const counts = facets.counts || {};

    licences = (facets.franchises || [])
      .map((ref) => {
        const count = counts[`franchises:${ref}`] || 0;
        return {
          id: licenceFilterId(ref),
          ref,
          label: toEnglishFacetLabel(ref),
          count,
        };
      })
      .filter((l) => shouldShowLicenceFacet(l.ref, l.count))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "en"))
      .slice(0, 120);

    brands = (facets.brands || [])
      .map((name) => ({
        id: name,
        label: toEnglishFacetLabel(name) || name,
        count: counts[`brands:${name}`] || 0,
      }))
      .filter((b) => b.count > 0)
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "en"))
      .slice(0, 200);
  } catch {
    licences = [];
    brands = [];
  }

  return {
    licences,
    brands,
    productTypes,
  };
}
