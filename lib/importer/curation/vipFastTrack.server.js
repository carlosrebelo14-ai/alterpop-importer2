/**
 * Compatibilidade — filtro actual em structuredCatalogFilter.server.js
 */
export {
  PREMIUM_BRANDS as VIP_BRANDS,
  PREMIUM_FRANCHISE_TAGS as VIP_LICENSES,
  GIFT_VENDOR_BRANDS,
  evaluateStructuredCatalogFilter,
  collectMappedCatalogTokens,
  collectEliteMatchFields,
  detectEliteUniverse,
  normalizeFilterText,
  textContainsNormalized,
  logPremiumRejectionAlert,
  isProbablyPremiumProduct,
  brandMatches,
} from "./structuredCatalogFilter.server.js";

export const PROFITABLE_KEYWORDS = [];
