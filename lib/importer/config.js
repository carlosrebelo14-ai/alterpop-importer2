import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..", "..");
dotenv.config({ path: path.join(projectRoot, ".env") });

function envBool(key, defaultValue = false) {
  const v = process.env[key];
  if (v === undefined || v === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function envInt(key, defaultValue) {
  const n = parseInt(process.env[key] ?? "", 10);
  return Number.isFinite(n) ? n : defaultValue;
}

export function getDefaultConfig() {
  return {
    shopify: {
      graphqlConcurrency: envInt("SHOPIFY_GRAPHQL_CONCURRENCY", 2),
      graphqlMinMs: envInt("SHOPIFY_GRAPHQL_MIN_MS", 250),
      apiVersion: process.env.SHOPIFY_API_VERSION || "2025-10",
    },
    ociostock: {
      csvUrl: process.env.OCIOSTOCK_CSV_URL || "",
      localPath: process.env.OCIOSTOCK_CSV_PATH || "",
    },
    translation: {
      provider: (process.env.TRANSLATION_PROVIDER || "deepl").toLowerCase(),
      apiKey: process.env.TRANSLATION_API_KEY || "",
      sourceLang: process.env.TRANSLATION_SOURCE_LANG || "ES",
      targetLang: process.env.TRANSLATION_TARGET_LANG || "EN",
      libreTranslateUrl: (process.env.LIBRETRANSLATE_URL || "https://libretranslate.com").replace(
        /\/$/,
        ""
      ),
    },
    import: {
      dryRun: envBool("DRY_RUN", false),
      batchSize: envInt("BATCH_SIZE", 20),
      batchDelayMs: envInt("BATCH_DELAY_MS", 1000),
      productDelayMs: envInt("PRODUCT_DELAY_MS", 300),
      syncProducts: envBool("SYNC_PRODUCTS", true),
      syncInventory: envBool("SYNC_INVENTORY", true),
      importMode: process.env.IMPORT_MODE || "CREATE_AND_UPDATE",
      syncLimit: envInt("SYNC_LIMIT", 0),
      skuAllowlist: (process.env.SKU_ALLOWLIST || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      locationId: process.env.SHOPIFY_LOCATION_ID || "",
    },
    paths: {
      root: projectRoot,
      cache: path.join(projectRoot, "cache"),
      results: path.join(projectRoot, "results"),
      data: path.join(projectRoot, "data"),
      serverData: path.join(projectRoot, "server", "data"),
      curation: path.join(projectRoot, "config", "curation.json"),
      translationCache: path.join(projectRoot, "cache", "translations.json"),
    },
  };
}

export const config = getDefaultConfig();

export function mergeImportOptions(overrides = {}) {
  const base = getDefaultConfig();
  return {
    ...base,
    import: {
      ...base.import,
      ...overrides,
      skuAllowlist:
        overrides.skuAllowlist !== undefined
          ? overrides.skuAllowlist
          : base.import.skuAllowlist,
    },
  };
}
