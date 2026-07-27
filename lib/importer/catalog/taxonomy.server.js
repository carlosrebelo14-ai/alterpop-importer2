import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getDefaultConfig } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function taxonomyPath() {
  return path.join(getDefaultConfig().paths.serverData, "taxonomy-map.json");
}

/** @type {{ version: number, locale: string, sections: TaxonomySection[] } | null} */
let cachedTaxonomy = null;

/**
 * @typedef {{ id: string, title: string, children: TaxonomyChild[] }} TaxonomySection
 * @typedef {{ id: string, label: string, matchKeys: string[], franchiseHints?: string[], vendorMatch?: boolean }} TaxonomyChild
 */

export function loadTaxonomyMap() {
  if (cachedTaxonomy) return cachedTaxonomy;
  const raw = fs.readFileSync(taxonomyPath(), "utf8");
  cachedTaxonomy = JSON.parse(raw);
  return cachedTaxonomy;
}

/** @param {string} value */
function norm(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * @typedef {{ sku: string, title: string, categoryMain: string, categorySegments?: string[], vendor: string, stock: number, franchises?: string[] }} CatalogLiteProduct
 */

/** @param {CatalogLiteProduct} p */
function allCategoryTokens(p) {
  const tokens = new Set();
  if (p.categoryMain) tokens.add(norm(p.categoryMain));
  for (const seg of p.categorySegments || []) {
    if (seg) tokens.add(norm(seg));
  }
  return tokens;
}

/** @param {CatalogLiteProduct} p @param {string[]} keys */
function matchesTokens(p, keys) {
  const tokens = allCategoryTokens(p);
  const normalizedKeys = keys.map(norm);
  return normalizedKeys.some((k) => {
    for (const t of tokens) {
      if (t === k || t.includes(k) || k.includes(t)) return true;
    }
    return false;
  });
}

/** @param {CatalogLiteProduct} p @param {string[]} hints */
function matchesFranchise(p, hints) {
  const fr = (p.franchises || []).map(norm).join(" ");
  return hints.some((h) => fr.includes(norm(h)));
}

/** @param {CatalogLiteProduct} p @param {TaxonomyChild} child */
function buildChildMatcher(child) {
  const keys = child.matchKeys || [];
  const franchiseHints = child.franchiseHints || [];
  return (p) => {
    if (child.vendorMatch && Boolean(p.vendor?.trim())) return true;
    return (
      matchesTokens(p, keys) ||
      (franchiseHints.length > 0 && matchesFranchise(p, franchiseHints))
    );
  };
}

/**
 * Secções para UI (accordion) — títulos em inglês.
 */
export function getTaxonomySectionsForUi() {
  const { sections } = loadTaxonomyMap();
  return sections.map((section) => ({
    id: section.id,
    title: section.title,
    children: section.children.map((c) => ({
      id: c.id,
      label: c.label,
    })),
  }));
}

export function getAllTaxonomyFilterIds() {
  const taxonomy = loadTaxonomyMap();
  const fromProductTypes = (taxonomy.productTypes || []).map((p) => p.id);
  const fromSections = taxonomy.sections.flatMap((s) => s.children.map((c) => c.id));
  return [...new Set([...fromProductTypes, ...fromSections])];
}

export function getTaxonomySectionIds() {
  return loadTaxonomyMap().sections.map((s) => s.id);
}

/** Mapa filterId → matcher */
export function buildTaxonomyMatcherMap() {
  /** @type {Map<string, (p: CatalogLiteProduct) => boolean>} */
  const map = new Map();
  const taxonomy = loadTaxonomyMap();
  const productTypes = taxonomy.productTypes || [];
  for (const pt of productTypes) {
    map.set(pt.id, buildChildMatcher(pt));
  }
  for (const section of taxonomy.sections) {
    for (const child of section.children) {
      if (!map.has(child.id)) map.set(child.id, buildChildMatcher(child));
    }
  }
  return map;
}

/**
 * Expande IDs de secção principal para todas as sub-tags.
 * @param {string[]} filterIds
 */
export function expandFilterIdsForQuery(filterIds = []) {
  const taxonomy = loadTaxonomyMap();
  const expanded = new Set();

  for (const id of filterIds) {
    if (String(id).startsWith("lic:")) {
      expanded.add(id);
      continue;
    }
    const section = taxonomy.sections.find((s) => s.id === id);
    if (section) {
      for (const child of section.children) expanded.add(child.id);
      continue;
    }
    expanded.add(id);
  }

  return [...expanded];
}

/**
 * @param {CatalogLiteProduct} product
 * @returns {string[]}
 */
export function computeTaxonomyFilterTagIds(product) {
  const matcherMap = buildTaxonomyMatcherMap();
  const ids = [];
  for (const [id, fn] of matcherMap) {
    if (fn(product)) ids.push(id);
  }
  return ids;
}
