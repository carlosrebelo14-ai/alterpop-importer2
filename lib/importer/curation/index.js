export { loadCuration, normalizeForMatch } from "./loadCuration.js";
export {
  evaluateCurationRules,
  resolveProductStatus,
  resolveProductStatusSync,
  resolveProductStatus as shouldImport,
  invalidateCurationQueueCache,
} from "./visibilityGatekeeper.js";
export { evaluateSmartRules, countSmartRuleDecisions } from "./smartRules.server.js";
export {
  PREMIUM_BRANDS,
  PREMIUM_FRANCHISE_TAGS,
  GIFT_VENDOR_BRANDS,
  collectMappedCatalogTokens,
  evaluateStructuredCatalogFilter,
  isCollectibleCategory,
  isValidGiftMerch,
  isPremiumVendor,
  detectEliteUniverse,
  normalizeFilterText,
  logPremiumRejectionAlert,
} from "./structuredCatalogFilter.server.js";
export { VIP_BRANDS, VIP_LICENSES } from "./vipFastTrack.server.js";
export {
  evaluateEliteCuration,
  isPremiumBrand,
  purgeEliteCatalog,
  readElitePurgeLog,
  shouldPurgeEliteProduct,
} from "./eliteCuration.server.js";
