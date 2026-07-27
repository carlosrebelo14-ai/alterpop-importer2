import fs from "fs/promises";
import path from "path";
import { getDefaultConfig } from "./config.js";
import { resolveTranslationConfig } from "./transform/translationConfig.js";

const SETTINGS_DIR = path.join(getDefaultConfig().paths.data, "settings");

export async function loadShopSettings(shop) {
  await fs.mkdir(SETTINGS_DIR, { recursive: true });
  const file = path.join(SETTINGS_DIR, `${shop.replace(/\//g, "_")}.json`);
  const defaults = getDefaultSettings();

  try {
    const raw = await fs.readFile(file, "utf8");
    return { ...defaults, ...JSON.parse(raw) };
  } catch {
    return defaults;
  }
}

export async function saveShopSettings(shop, settings) {
  await fs.mkdir(SETTINGS_DIR, { recursive: true });
  const file = path.join(SETTINGS_DIR, `${shop.replace(/\//g, "_")}.json`);
  await fs.writeFile(file, JSON.stringify(settings, null, 2));
}

export function getDefaultSettings() {
  const cfg = getDefaultConfig();
  const { provider, apiKey } = resolveTranslationConfig({
    translationProvider: cfg.translation.provider,
    translationApiKey: cfg.translation.apiKey,
    translateToEnglish: true,
  });

  return {
    ociostockCsvUrl: cfg.ociostock.csvUrl,
    translationProvider: provider,
    translationApiKey: apiKey,
    translateToEnglish: false,
    autoGlossaryTranslation: true,
    importMode: cfg.import.importMode,
    syncLimit: cfg.import.syncLimit,
    skuAllowlist: cfg.import.skuAllowlist.join(", "),
    locationId: cfg.import.locationId,
    syncProducts: cfg.import.syncProducts,
    syncInventory: cfg.import.syncInventory,
    syncImages: true,
    syncPrices: true,
    batchSize: cfg.import.batchSize,
    importInStockOnly: false,
    csvColumnMap: {},
    savedFilters: {},
  };
}

/**
 * @param {import('./types.js').ImportFilters} filters
 */
export function parseFiltersFromForm(form) {
  const getAll = (name) => form.getAll(name).map(String).filter(Boolean);
  const inStockOnly = form.get("inStockOnly") === "on";

  const filters = {
    categoryMain: getAll("categoryMain"),
    categorySegments: getAll("categorySegments"),
    brands: getAll("brands"),
    franchises: getAll("franchises"),
    inStockOnly,
    availability: getAll("availability"),
  };

  const hasAny =
    filters.categoryMain.length ||
    filters.categorySegments.length ||
    filters.brands.length ||
    filters.franchises.length ||
    filters.inStockOnly ||
    filters.availability.length;

  return hasAny ? filters : {};
}
