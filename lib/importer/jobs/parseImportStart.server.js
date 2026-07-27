import { getDefaultConfig } from "../config.js";
import { loadShopSettings, parseFiltersFromForm } from "../settings.server.js";

/**
 * Opções comuns para POST /api/import/start e acções da UI.
 * @param {FormData} form
 * @param {{ shop: string }} session
 */
export async function parseImportStartFromForm(form, session) {
  const settings = await loadShopSettings(session.shop);
  const intent = form.get("intent");
  const dryRun = intent === "dry-run" || form.get("dryRun") === "true";

  if (!dryRun && getDefaultConfig().import.dryRun) {
    return {
      error:
        "Live import blocked: DRY_RUN=true no servidor. Altera .env (DRY_RUN=false) e reinicia npm run dev, ou usa Dry run.",
    };
  }

  const productsOnly = form.get("productsOnly") === "on";
  const inventoryOnly = form.get("inventoryOnly") === "on";
  const syncLimit = parseInt(form.get("syncLimit") || "0", 10) || 0;
  let filters = parseFiltersFromForm(form);
  if (!filters.inStockOnly && settings.importInStockOnly) {
    filters = { ...filters, inStockOnly: true };
  }

  const skuAllowlistRaw = form.get("skuAllowlist");
  const skuAllowlist = skuAllowlistRaw
    ? String(skuAllowlistRaw)
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const runSettings = {
    ...settings,
    syncLimit: skuAllowlist.length > 0 ? skuAllowlist.length : syncLimit,
    skuAllowlist: skuAllowlist.length > 0 ? skuAllowlist.join(", ") : settings.skuAllowlist,
    syncProducts: productsOnly || (!productsOnly && !inventoryOnly),
    syncInventory: inventoryOnly || (!productsOnly && !inventoryOnly),
    syncImages: form.get("syncImages") === "on",
    syncPrices: form.get("syncPrices") === "on",
    translateToEnglish: form.get("translateToEnglish") === "on",
    autoGlossaryTranslation: form.get("autoGlossaryTranslation") === "on",
    translationProvider: settings.translationProvider,
    translationApiKey: settings.translationApiKey,
  };

  return {
    dryRun,
    filters,
    productsOnly,
    inventoryOnly,
    settings: runSettings,
  };
}
