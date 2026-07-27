import { lookupCategoryGlossary } from "../transform/glossary/index.js";
import { humanizeFranchiseRef } from "../connectors/ociostock/parseFamilies.js";
import { loadTaxonomyMap } from "./taxonomy.server.js";

/** Franquias genéricas (não são licenças comerciais). */
const LICENCE_NOISE = new Set([
  "figuras",
  "pop culture",
  "articulos coleccion (pop culture)",
  "juguetes",
  "juegos",
  "manga",
  "anime",
  "figuras|pop vinyls",
  "pop vinyls",
  "pop",
  "pop!",
  "funko|pop!",
  "moda y complementos",
  "complementos",
  "regalo",
  "regalos",
  "menaje",
  "hogar",
  "management",
  "marcas",
  "brands",
]);

/**
 * Rótulo EN para facetas (glossário csvFieldMap / categorias).
 * @param {string} raw
 */
export function toEnglishFacetLabel(raw) {
  const key = String(raw || "").trim();
  if (!key) return "";
  if (key.startsWith("[UNTRANSLATED]")) {
    return key.replace(/^\[UNTRANSLATED\]\s*/i, "").trim();
  }
  const fromGlossary = lookupCategoryGlossary(key);
  if (fromGlossary) return fromGlossary;
  return humanizeFranchiseRef(key);
}

/**
 * @param {string} franchiseRef
 */
export function licenceFilterId(franchiseRef) {
  const slug = String(franchiseRef || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return `lic:${slug || "unknown"}`;
}

/**
 * @param {string} filterId
 */
export function decodeLicenceFilterId(filterId) {
  if (!filterId?.startsWith("lic:")) return "";
  return filterId.slice(4).replace(/_/g, " ");
}

/**
 * @param {string} filterId
 */
export function isLicenceFilterId(filterId) {
  return String(filterId || "").startsWith("lic:");
}

/**
 * @param {string[]} filterIds
 */
export function partitionFacetFilterIds(filterIds = []) {
  const licenceIds = [];
  const productTypeIds = [];
  for (const id of filterIds) {
    if (isLicenceFilterId(id)) licenceIds.push(id);
    else if (id) productTypeIds.push(id);
  }
  return { licenceIds, productTypeIds };
}

/**
 * Tipos de produto (EN) — única lista plana para o acordeão «Product Type».
 */
export function getProductTypeFacetsForUi() {
  const taxonomy = loadTaxonomyMap();
  if (Array.isArray(taxonomy.productTypes) && taxonomy.productTypes.length) {
    return taxonomy.productTypes.map((pt) => ({
      id: pt.id,
      label: pt.label,
      matchKeys: pt.matchKeys || [],
    }));
  }

  /** Fallback: filhos de taxonomia que não são licenças. */
  const licenceLabels = new Set(
    [
      "disney",
      "star wars",
      "comics & superheroes",
      "harry potter",
      "tv series",
      "video games",
      "clearance",
      "new arrivals",
      "brands",
    ].map((s) => s.toLowerCase())
  );

  const out = [];
  for (const section of taxonomy.sections || []) {
    for (const child of section.children || []) {
      if (licenceLabels.has(String(child.label).toLowerCase())) continue;
      out.push({ id: child.id, label: child.label, matchKeys: child.matchKeys || [] });
    }
  }
  return out;
}

/**
 * @param {string} ref
 * @param {number} count
 */
export function shouldShowLicenceFacet(ref, count) {
  const label = toEnglishFacetLabel(ref).toLowerCase();
  const norm = String(ref || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (count < 3) return false;
  if (LICENCE_NOISE.has(norm) || LICENCE_NOISE.has(label)) return false;
  if (norm.length < 2) return false;
  return true;
}

/**
 * @param {import('../types.js').ProductRecord} product
 */
export function computeLicenceFilterIdsForProduct(product) {
  const ids = [];
  for (const ref of product.franchises || []) {
    if (!ref) continue;
    ids.push(licenceFilterId(ref));
  }
  return [...new Set(ids)];
}
