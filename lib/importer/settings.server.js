import fs from "fs/promises";
import path from "path";
import { getDefaultConfig } from "./config.js";
import { resolveTranslationConfig } from "./transform/translationConfig.js";
import { DEFAULT_MARGIN_PCT } from "./pricing/pricing.server.js";

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
    // Item 17 do roadmap — buffer de segurança subtraído ao stock do fornecedor
    // antes de publicar na Shopify (0 = comportamento inalterado).
    stockBuffer: 0,
    // Redesign da Curadoria (2026-08-12) — margem % abaixo da qual a coluna "Margem"
    // é destacada visualmente na tabela (aviso de margem baixa), só apresentação.
    marginWarnThresholdPct: 30,
    // Briefing de preço (07/10/2026) — margem global sobre o custo com IVA, 5 a 100 %.
    // Editada no painel de Curadoria (seletor "Aplicar margem"); lida por pricing.server.js.
    priceMarginPct: DEFAULT_MARGIN_PCT,
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
