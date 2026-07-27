import fs from "fs";
import path from "path";
import { getDefaultConfig } from "../config.js";
import { normalizeForMatch } from "./loadCuration.js";
import { humanizeFranchiseRef } from "../connectors/ociostock/parseFamilies.js";
import { loadExcludeList, normalizeBrand } from "./loadExcludeList.server.js";
import {
  DEFAULT_MARKET_SETTINGS,
  loadMarketSettings,
} from "./dynamicRules.server.js";

/** Normalização rígida para filtros (case-insensitive). */
export function normalizeFilterText(text) {
  return normalizeForMatch(text);
}

/** Compatibilidade retro: agora vêm de marketSettings.json. */
export const PREMIUM_BRANDS = [...DEFAULT_MARKET_SETTINGS.vipBrands];
export const PREMIUM_FRANCHISE_TAGS = [...DEFAULT_MARKET_SETTINGS.vipLicences];
const DEFAULT_ELITE_KEYWORDS = [
  ...DEFAULT_MARKET_SETTINGS.vipBrands,
  ...DEFAULT_MARKET_SETTINGS.vipLicences,
];

/** Marcas de merch gift (canecas, candeeiros, keyrings). */
export const GIFT_VENDOR_BRANDS = ["abystyle", "paladone", "sd toys", "pyramid international"];

function getDynamicRuleSets() {
  const market = loadMarketSettings();
  return {
    premiumBrands: market.vipBrands,
    premiumFranchiseTags: market.vipLicences,
    eliteKeywords: [...new Set([...market.vipBrands, ...market.vipLicences, ...market.blockedTerms])],
    vipCategories: market.vipCategories,
    blockedTerms: market.blockedTerms,
  };
}

let taxonomyCache = null;

function loadTaxonomyMap() {
  if (taxonomyCache) return taxonomyCache;
  const filePath = path.join(getDefaultConfig().paths.serverData, "taxonomy-map.json");
  taxonomyCache = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return taxonomyCache;
}

/**
 * @param {string} haystack
 * @param {string} needle
 */
export function textContainsNormalized(haystack, needle) {
  const h = normalizeFilterText(haystack);
  const n = normalizeFilterText(needle);
  if (!h || !n) return false;
  const hAscii = h.normalize("NFD").replace(/\p{M}/gu, "");
  const nAscii = n.normalize("NFD").replace(/\p{M}/gu, "");
  return h.includes(n) || hAscii.includes(nAscii) || n.includes(h) || nAscii.includes(hAscii);
}

/**
 * Tokens estruturados pós csvFieldMap (categorias, productTypePath, franchises).
 * @param {import('../types.js').ProductRecord} record
 */
export function collectMappedCatalogTokens(record) {
  /** @type {Set<string>} */
  const tokens = new Set();

  const add = (value) => {
    if (value == null || value === "") return;
    const raw = String(value).trim();
    if (!raw) return;
    tokens.add(normalizeFilterText(raw));
    for (const part of raw.split(/[|/]/)) {
      const seg = part.trim();
      if (seg) tokens.add(normalizeFilterText(seg));
    }
  };

  add(record.category);
  add(record.categoryMain);
  add(record.productTypePath);
  add(record._source?.category);

  for (const seg of record.categorySegments || []) {
    add(seg);
  }

  for (const tag of record.franchises || []) {
    add(tag);
    add(humanizeFranchiseRef(tag));
  }

  return [...tokens];
}

/**
 * Campos de texto onde procuramos marcas/licenças de elite.
 * @param {import('../types.js').ProductRecord} record
 */
export function collectEliteMatchFields(record) {
  const fields = [
    record.vendor,
    record.title,
    record.description,
    record.category,
    record.categoryMain,
    record.productTypePath,
  ];

  for (const tag of record.franchises || []) {
    fields.push(tag);
    fields.push(humanizeFranchiseRef(tag));
  }

  for (const token of collectMappedCatalogTokens(record)) {
    fields.push(token);
  }

  return fields.filter(Boolean);
}

/**
 * @param {string} vendorNorm
 * @param {string} brandNorm
 */
export function brandMatches(vendorNorm, brandNorm) {
  const v = normalizeFilterText(vendorNorm);
  const b = normalizeFilterText(brandNorm);
  if (!v || !b) return false;
  const vAscii = v.normalize("NFD").replace(/\p{M}/gu, "");
  const bAscii = b.normalize("NFD").replace(/\p{M}/gu, "");
  return v === b || v.includes(b) || b.includes(v) || vAscii.includes(bAscii) || bAscii.includes(vAscii);
}

function matchesTokenSet(tokens, patterns) {
  for (const token of tokens) {
    for (const pattern of patterns) {
      const p = normalizeFilterText(pattern);
      if (!p) continue;
      if (token === p || token.includes(p) || p.includes(token)) return true;
      const pAscii = p.normalize("NFD").replace(/\p{M}/gu, "");
      const tAscii = token.normalize("NFD").replace(/\p{M}/gu, "");
      if (tAscii.includes(pAscii) || pAscii.includes(tAscii)) return true;
    }
  }
  return false;
}

function getStructuredRules() {
  const cfg = loadExcludeList();
  const dyn = getDynamicRuleSets();
  const tax = loadTaxonomyMap();
  const fromTaxCollectible = [];
  const fromTaxJunk = [];
  const fromTaxGift = [];

  for (const section of tax.sections || []) {
    for (const child of section.children || []) {
      const label = child.label || "";
      const keys = child.matchKeys || [];
      const id = child.id || "";
      if (/stationery|papeler|escolar/i.test(id) || /stationery|papeler|escolar/i.test(label)) {
        fromTaxJunk.push(...keys, label);
      }
      if (/figure|statue|replica|board game|trading card|puzzle/i.test(label + id)) {
        fromTaxCollectible.push(...keys, label);
      }
      if (/mug|taza|lamp|keyring|llavero|candeeiro/i.test(label + id)) {
        fromTaxGift.push(...keys, label);
      }
    }
  }

  const sr = cfg.structuredRules || {};

  return {
    collectibleCategoryKeys: [
      ...(sr.collectibleCategoryKeys || []),
      ...dyn.vipCategories,
      ...fromTaxCollectible,
      "action figures",
      "figures & statues",
      "statues",
      "replicas",
      "replica",
      "board games",
      "trading cards",
      "puzzles",
      "diorama",
      "figurine",
      "figuras",
      "estatuas",
      "juegos de mesa",
    ],
    giftCategoryKeys: [
      ...(sr.giftCategoryKeys || []),
      ...fromTaxGift,
      "mugs",
      "tazas",
      "lamps",
      "lamp",
      "candeeiros",
      "keyrings",
      "llaveros",
      "portachaves",
    ],
    giftVendorBrands: [...(sr.giftVendorBrands || []), ...GIFT_VENDOR_BRANDS],
    premiumFranchiseTags: [...(sr.premiumFranchiseTags || []), ...dyn.premiumFranchiseTags],
    premiumBrands: [...(sr.premiumBrands || []), ...dyn.premiumBrands],
    junkCategoryKeys: [
      ...(sr.junkCategoryKeys || []),
      ...fromTaxJunk,
      ...(cfg.blockedCategories || []),
    ],
    junkCategoryContains: [
      ...(sr.junkCategoryContains || []),
      ...dyn.blockedTerms,
      ...(cfg.blockedCategoryContains || []),
    ],
    genericTextilContains: sr.genericTextilContains || [
      "textil",
      "ropa",
      "moda",
      "vestuario",
      "complementos",
      "moda y complementos",
    ],
    textilExceptions: sr.textilExceptions || [
      "cosplay",
      "replica",
      "réplica",
      "disfraz",
      "disfrazes",
      "manto",
      "capa",
      "uniforme",
    ],
    minNetPriceEur: Number(cfg.rules?.minNetPriceEur) > 0 ? Number(cfg.rules.minNetPriceEur) : 4,
  };
}

/**
 * Short-circuit: marca, título ou tags do universo colecionador.
 * @param {import('../types.js').ProductRecord} record
 * @param {ReturnType<typeof getStructuredRules>} [rules]
 */
export function detectEliteUniverse(record, rules = getStructuredRules()) {
  const fields = collectEliteMatchFields(record);
  const dyn = getDynamicRuleSets();
  const eliteKeywords = dyn.eliteKeywords.length ? dyn.eliteKeywords : DEFAULT_ELITE_KEYWORDS;

  for (const field of fields) {
    for (const brand of rules.premiumBrands) {
      if (textContainsNormalized(field, brand) || brandMatches(field, brand)) {
        return { matched: true, track: "brand", signal: `brand:${brand}` };
      }
    }
    for (const tag of rules.premiumFranchiseTags) {
      if (textContainsNormalized(field, tag)) {
        return { matched: true, track: "franchise", signal: `franchise:${tag}` };
      }
    }
    for (const kw of eliteKeywords) {
      if (textContainsNormalized(field, kw)) {
        const track = rules.premiumFranchiseTags.some(
          (t) => normalizeFilterText(t) === normalizeFilterText(kw)
        )
          ? "franchise"
          : "brand";
        return { matched: true, track, signal: `keyword:${kw}` };
      }
    }
  }

  return { matched: false, track: null, signal: null };
}

/**
 * @param {import('../types.js').ProductRecord} record
 * @param {ReturnType<typeof getStructuredRules>} [rules]
 */
export function isProbablyPremiumProduct(record, rules = getStructuredRules()) {
  if (detectEliteUniverse(record, rules).matched) return true;
  const tokens = collectMappedCatalogTokens(record);
  return isPremiumVendor(record, rules) || hasPremiumFranchiseTag(record, tokens, rules);
}

/**
 * @param {import('../types.js').ProductRecord} record
 * @param {string} reason
 */
export function logPremiumRejectionAlert(record, reason) {
  if (!isProbablyPremiumProduct(record)) return;
  const nombre = record.title || record._source?.nombre || record.sku || "—";
  console.log("⚠️ ALERTA: Produto Premium rejeitado:", nombre, "Motivo:", reason);
}

/**
 * @param {import('../types.js').ProductRecord} record
 * @param {{ pass: boolean, excluded: boolean, reason?: string, fastTrack?: boolean, track?: string | null }} result
 */
function finalizeFilterResult(record, result) {
  if (result.excluded) {
    logPremiumRejectionAlert(record, result.reason || "unknown");
  }
  return result;
}

/**
 * @param {import('../types.js').ProductRecord} record
 * @param {ReturnType<typeof getStructuredRules>} rules
 */
export function isPremiumVendor(record, rules = getStructuredRules()) {
  const vendorNorm = normalizeFilterText(record.vendor || "");
  const titleNorm = normalizeFilterText(record.title || "");
  return rules.premiumBrands.some(
    (b) => brandMatches(vendorNorm, b) || textContainsNormalized(titleNorm, b)
  );
}

/**
 * @param {import('../types.js').ProductRecord} record
 * @param {string[]} tokens
 * @param {ReturnType<typeof getStructuredRules>} rules
 */
export function hasPremiumFranchiseTag(record, tokens, rules = getStructuredRules()) {
  const franchiseTokens = (record.franchises || []).flatMap((f) => [
    normalizeFilterText(f),
    normalizeFilterText(humanizeFranchiseRef(f)),
  ]);
  const titleNorm = normalizeFilterText(record.title || "");
  const haystack = [...tokens, ...franchiseTokens, titleNorm];
  return matchesTokenSet(haystack, rules.premiumFranchiseTags);
}

/**
 * @param {string[]} tokens
 * @param {ReturnType<typeof getStructuredRules>} rules
 */
export function isCollectibleCategory(tokens, rules = getStructuredRules()) {
  return matchesTokenSet(tokens, rules.collectibleCategoryKeys);
}

/**
 * @param {string[]} tokens
 * @param {import('../types.js').ProductRecord} record
 * @param {ReturnType<typeof getStructuredRules>} rules
 */
export function isValidGiftMerch(tokens, record, rules = getStructuredRules()) {
  if (!matchesTokenSet(tokens, rules.giftCategoryKeys)) return false;
  const vendorNorm = normalizeFilterText(record.vendor || "");
  return rules.giftVendorBrands.some((b) => brandMatches(vendorNorm, b)) || isPremiumVendor(record, rules);
}

/**
 * @param {string[]} tokens
 * @param {ReturnType<typeof getStructuredRules>} rules
 */
export function isExplicitJunkCategory(tokens, rules = getStructuredRules()) {
  if (matchesTokenSet(tokens, rules.junkCategoryKeys)) return true;
  for (const token of tokens) {
    for (const needle of rules.junkCategoryContains) {
      const n = normalizeFilterText(needle);
      if (n && token.includes(n)) return true;
    }
  }
  return false;
}

/**
 * @param {string[]} tokens
 * @param {ReturnType<typeof getStructuredRules>} rules
 */
export function isGenericTextil(tokens, rules = getStructuredRules()) {
  const hitTextil = matchesTokenSet(tokens, rules.genericTextilContains);
  if (!hitTextil) return false;
  return !matchesTokenSet(tokens, rules.textilExceptions);
}

/**
 * @param {import('../types.js').ProductRecord} record
 */
export function hasValidMappedBrand(record) {
  const vendorNorm = normalizeFilterText(record.vendor || "");
  if (!vendorNorm) return false;

  const cfg = loadExcludeList();
  for (const blocked of cfg.blockedBrands || []) {
    if (vendorNorm === normalizeBrand(blocked)) return false;
  }

  if (isPremiumVendor(record)) return true;

  const rules = getStructuredRules();
  if (rules.giftVendorBrands.some((b) => brandMatches(vendorNorm, b))) return true;

  return vendorNorm.length >= 2;
}

/**
 * @param {import('../types.js').ProductRecord} record
 */
export function hasStock(record) {
  return (record.availableQuantity ?? 0) > 0 || record.hasStock === true;
}

/**
 * Filtro principal — usar APÓS mapOcioStockRow + normalizeRecordCategories.
 * Ordem: (1) short-circuit elite → (2) restantes regras (preço/papelaria não bloqueiam elite).
 * @param {import('../types.js').ProductRecord} record
 */
export function evaluateStructuredCatalogFilter(record) {
  const cfg = loadExcludeList();
  const rules = getStructuredRules();

  const elite = detectEliteUniverse(record, rules);
  if (elite.matched) {
    return {
      pass: true,
      excluded: false,
      fastTrack: true,
      track: elite.track,
      reason: `elite_short_circuit:${elite.signal}`,
    };
  }

  const vendorNorm = normalizeBrand(record.vendor);

  for (const blocked of cfg.blockedBrands || []) {
    if (vendorNorm === normalizeBrand(blocked)) {
      return finalizeFilterResult(record, {
        pass: false,
        excluded: true,
        reason: `blocked_brand:${blocked}`,
      });
    }
  }

  const tokens = collectMappedCatalogTokens(record);

  if (isCollectibleCategory(tokens, rules)) {
    return {
      pass: true,
      excluded: false,
      fastTrack: true,
      track: "collectible",
      reason: "structured_collectible",
    };
  }

  if (hasPremiumFranchiseTag(record, tokens, rules)) {
    return {
      pass: true,
      excluded: false,
      fastTrack: true,
      track: "franchise",
      reason: "structured_franchise_tag",
    };
  }

  if (isPremiumVendor(record, rules)) {
    return {
      pass: true,
      excluded: false,
      fastTrack: true,
      track: "brand",
      reason: "structured_premium_brand",
    };
  }

  if (isValidGiftMerch(tokens, record, rules)) {
    return {
      pass: true,
      excluded: false,
      fastTrack: true,
      track: "gift",
      reason: "structured_gift_merch",
    };
  }

  if (isExplicitJunkCategory(tokens, rules)) {
    return finalizeFilterResult(record, {
      pass: false,
      excluded: true,
      reason: "structured_junk_category",
    });
  }

  if (isGenericTextil(tokens, rules)) {
    return finalizeFilterResult(record, {
      pass: false,
      excluded: true,
      reason: "structured_generic_textil",
    });
  }

  if (!hasStock(record) && !hasValidMappedBrand(record)) {
    return finalizeFilterResult(record, {
      pass: false,
      excluded: true,
      reason: "structured_no_brand_no_stock",
    });
  }

  const net = record.netPrice != null ? Number(record.netPrice) : null;
  if (net != null && Number.isFinite(net) && net > 0 && net < rules.minNetPriceEur) {
    return finalizeFilterResult(record, {
      pass: false,
      excluded: true,
      reason: `structured_min_price:${net}<${rules.minNetPriceEur}`,
    });
  }

  if (cfg.rules?.excludeLiquidation) {
    const liq = record.enLiquidacion ?? record._source?.en_liquidacion;
    if (liq === "1" || liq === 1 || liq === true) {
      return finalizeFilterResult(record, {
        pass: false,
        excluded: true,
        reason: "liquidation",
      });
    }
  }

  if (cfg.rules?.excludeIfNoStock && !hasStock(record)) {
    return finalizeFilterResult(record, {
      pass: false,
      excluded: true,
      reason: "no_stock",
    });
  }

  return { pass: true, excluded: false, fastTrack: false, reason: "structured_default_pass" };
}
