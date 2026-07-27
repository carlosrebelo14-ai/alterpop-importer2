import fs from "fs/promises";
import path from "path";
import { getDefaultConfig } from "../config.js";
import { getCatalogFacetsForUi } from "./catalogFacets.server.js";
import { queryCatalogProducts } from "./catalogProductsDb.server.js";
import {
  franchiseRefScore,
  isPlausibleFranchiseRef,
  norm,
  textMatchesQuery,
} from "./catalogFilterText.server.js";
import { licenceFilterId, toEnglishFacetLabel } from "./facetRegistry.server.js";

function catalogIndexPath(shop) {
  return path.join(
    getDefaultConfig().paths.data,
    "catalog-index",
    `${shop.replace(/\//g, "_")}.json`
  );
}

/**
 * Licenças fora do top-120 da sidebar (ex. Lord of the Rings com contagens fragmentadas).
 * @param {string} shop
 * @param {string} query
 */
export async function resolveLicenceIdsFromCatalogIndex(shop, query) {
  if (!query?.trim()) return [];
  try {
    const raw = await fs.readFile(catalogIndexPath(shop), "utf8");
    const index = JSON.parse(raw);
    const franchises = index.facets?.franchises || [];
    const counts = index.facets?.counts || {};

    const matches = franchises
      .filter(isPlausibleFranchiseRef)
      .map((ref) => {
        const label = toEnglishFacetLabel(ref);
        const count = counts[`franchises:${ref}`] || 0;
        return {
          ref,
          label,
          count,
          id: licenceFilterId(ref),
        };
      })
      .filter(
        (l) =>
          l.count > 0 &&
          (textMatchesQuery(l.label, query) || textMatchesQuery(l.ref, query))
      )
      .sort(
        (a, b) =>
          franchiseRefScore(b.ref) - franchiseRefScore(a.ref) ||
          b.count - a.count ||
          a.ref.length - b.ref.length
      );

    const ids = [...new Set(matches.slice(0, 2).map((l) => l.id))];
    return ids.slice(0, 1);
  } catch {
    return [];
  }
}

function contains(haystack, needle) {
  return textMatchesQuery(haystack, needle);
}

/**
 * @param {{ id: string, label: string }[]} brands
 * @param {string} query
 */
export function resolveBrandId(brands, query) {
  if (!query?.trim()) return null;
  const exact = brands.find(
    (b) => norm(b.label) === norm(query) || norm(b.id) === norm(query)
  );
  if (exact) return exact.id;
  const partial = brands.find(
    (b) => contains(b.label, query) || contains(b.id, query)
  );
  return partial?.id || null;
}

/**
 * @param {{ id: string, label: string, ref?: string }[]} licences
 * @param {string} query
 */
export function resolveLicenceIds(licences, query) {
  if (!query?.trim()) return [];
  const matches = licences.filter(
    (l) =>
      contains(l.label, query) ||
      contains(l.ref || "", query) ||
      contains(l.id.replace(/^lic:/, "").replace(/_/g, " "), query)
  );
  matches.sort((a, b) => b.count - a.count);
  return matches.slice(0, 3).map((l) => l.id);
}

/**
 * @param {{ id: string, label: string }[]} productTypes
 * @param {string} query
 */
export function resolveProductTypeIds(productTypes, query) {
  if (!query?.trim()) return [];
  const exact = productTypes.find((p) => norm(p.label) === norm(query));
  if (exact) return [exact.id];
  const partial = productTypes.find((p) => contains(p.label, query));
  return partial ? [partial.id] : [];
}

/**
 * @param {string} shop
 * @param {Record<string, unknown>} args
 */
export async function resolveCatalogUiFilters(shop, args = {}) {
  const facets = await getCatalogFacetsForUi(shop);

  const brand = resolveBrandId(facets.brands, args.brand);
  const licenceQuery = args.licence || args.franchise;
  let licenceIds = resolveLicenceIds(facets.licences, licenceQuery);
  if (!licenceIds.length && licenceQuery) {
    licenceIds = await resolveLicenceIdsFromCatalogIndex(shop, String(licenceQuery));
  }

  const productTypeIds = resolveProductTypeIds(
    facets.productTypes,
    args.productType || args.product_type
  );

  let search = args.search ? String(args.search).trim() : "";

  if (licenceQuery && licenceIds.length === 0 && !search) {
    search = String(licenceQuery).trim();
  }

  const minPrice =
    args.minPrice != null && args.minPrice !== "" ? String(args.minPrice) : "";
  const maxPrice =
    args.maxPrice != null && args.maxPrice !== "" ? String(args.maxPrice) : "";
  const inStockOnly =
    args.inStockOnly === true ||
    args.inStockOnly === 1 ||
    args.inStockOnly === "1" ||
    args.inStockOnly === "true" ||
    args.inStockOnly === "on";

  let filterIds = [...new Set([...licenceIds, ...productTypeIds])];

  const previewLimit = 12;
  const queryOpts = {
    page: 1,
    limit: previewLimit,
    brand,
    search,
    filterIds,
    minPrice: minPrice || null,
    maxPrice: maxPrice || null,
    inStockOnly,
  };

  let preview = await queryCatalogProducts(shop, queryOpts);

  if (
    preview.totalCount === 0 &&
    licenceIds.length &&
    licenceQuery &&
    !args.search
  ) {
    licenceIds = [];
    search = String(licenceQuery).trim();
    filterIds = [...productTypeIds];
    preview = await queryCatalogProducts(shop, {
      ...queryOpts,
      search,
      filterIds,
    });
  }

  const productTypeLabel =
    facets.productTypes.find((p) => productTypeIds.includes(p.id))?.label ||
    args.productType ||
    args.product_type ||
    null;

  const brandLabel =
    facets.brands.find((b) => b.id === brand)?.label || brand || null;

  const licenceLabels = licenceIds.map((id) => {
    const fromFacet = facets.licences.find((l) => l.id === id);
    if (fromFacet) return fromFacet.label;
    return id.replace(/^lic:/, "").replace(/_/g, " ");
  });

  const filterSummaryParts = [];
  if (brandLabel) filterSummaryParts.push(`Brand: ${brandLabel}`);
  if (licenceLabels.length) {
    filterSummaryParts.push(`Licence: ${licenceLabels.join(", ")}`);
  }
  if (search) {
    filterSummaryParts.push(`Search: ${search}`);
  }
  if (productTypeLabel) filterSummaryParts.push(`Type: ${productTypeLabel}`);
  if (minPrice || maxPrice) {
    filterSummaryParts.push(
      `Price: ${minPrice || "0"}–${maxPrice || "∞"} €`
    );
  }
  if (inStockOnly) {
    filterSummaryParts.push("Em stock");
  }

  const previewProducts = (preview.products || []).map((p) => ({
    sku: p.sku,
    title: p.title,
    brand: p.vendor,
    stock: p.stock,
    netPrice: p.netPrice,
  }));

  return {
    uiFilters: {
      brand,
      search,
      licenceIds: [...licenceIds],
      productTypeIds,
      minPrice,
      maxPrice,
      inStockOnly,
    },
    totalCount: preview.totalCount,
    filterSummary: filterSummaryParts.join(" · ") || "All catalog",
    previewProducts,
    labels: {
      brand: brandLabel,
      licence: licenceLabels[0] || licenceQuery || null,
      productType: productTypeLabel,
      search: search || null,
    },
  };
}
