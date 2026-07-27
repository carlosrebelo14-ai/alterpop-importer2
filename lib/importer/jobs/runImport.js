/* global globalThis */
import { mergeImportOptions } from "../config.js";
import { SOURCE } from "../connectors/ociostock/index.js";
import { assertTranslationReady, resolveTranslationConfig } from "../transform/translationConfig.js";
import { createShopifyClientFromSession, resolveLocationId } from "../shopifyClient.js";
import { ImportJob } from "./ImportJob.js";
import { ProductImporter } from "../importers/ProductImporter.js";
import { InventoryImporter } from "../importers/InventoryImporter.js";
import { assertLiveImportAllowed } from "./dryRunGuard.js";
import { runStreamImport } from "../core/streamImport.js";
import { setActiveCsvColumnMap } from "../connectors/ociostock/csvFieldMap.js";

/**
 * @param {object} options
 * @param {{ shop: string, accessToken: string }} [options.session]
 * @param {boolean} [options.dryRun]
 * @param {boolean} [options.productsOnly]
 * @param {boolean} [options.inventoryOnly]
 * @param {object} [options.settings]
 * @param {import('../types.js').ImportFilters} [options.filters]
 * @param {(progress: { processed: number, total: number, currentSku?: string }) => void | Promise<void>} [options.onProgress]
 */
export async function runImport(options = {}) {
  const settings = options.settings || {};
  const dryRun = options.dryRun ?? false;

  assertLiveImportAllowed(dryRun);
  if (!dryRun) assertTranslationReady(settings);

  const ctx = mergeImportOptions({
    dryRun,
    syncProducts: options.productsOnly
      ? true
      : options.inventoryOnly
        ? false
        : settings.syncProducts ?? true,
    syncInventory: options.inventoryOnly
      ? true
      : options.productsOnly
        ? false
        : settings.syncInventory ?? true,
    importMode: settings.importMode,
    syncLimit: settings.syncLimit ?? 0,
    skuAllowlist: parseAllowlist(settings.skuAllowlist),
    locationId: settings.locationId,
  });

  applySettingsEnv(settings);
  setActiveCsvColumnMap(settings.csvColumnMap || {});

  const job = new ImportJob({
    jobId: options.jobIdOverride,
    dryRun: ctx.import.dryRun,
    source: SOURCE,
    importMode: ctx.import.importMode || "CREATE_AND_UPDATE",
    shop: options.session?.shop || "",
  });
  job.status = "running";
  await job.ensureResultsDir();

  const loadTest = options.loadTest === true;
  const validationOpts = {
    syncPrices: loadTest || (!dryRun && settings.syncPrices !== false),
    requirePrice: loadTest || settings.syncPrices !== false,
    syncImages: !dryRun && settings.syncImages !== false,
    requireTitle: !dryRun && !loadTest,
  };

  const syncProducts =
    !options.inventoryOnly && (options.productsOnly || ctx.import.syncProducts);
  const syncInventory =
    !options.productsOnly && (options.inventoryOnly || ctx.import.syncInventory);

  let client = null;
  if (!ctx.import.dryRun) {
    if (!options.session?.accessToken) {
      throw new Error("Shopify session required for live import");
    }
    client = createShopifyClientFromSession(options.session);
    ctx.import.locationId = await resolveLocationId(client, ctx.import.locationId);
  }

  const blockedClient = {
    graphql: async () => {
      throw new Error("GraphQL blocked: DRY_RUN=true — no Shopify API calls allowed");
    },
  };
  const activeClient = client || (ctx.import.dryRun ? blockedClient : { graphql: async () => ({}) });

  const productImporter = syncProducts
    ? new ProductImporter(job, activeClient, settings)
    : null;
  const inventoryImporter = syncInventory
    ? new InventoryImporter(job, activeClient)
    : null;
  if (inventoryImporter) {
    inventoryImporter.locationId = ctx.import.locationId;
  }

  if (productImporter) {
    await productImporter.prepare();
  }

  const streamResult = await runStreamImport({
    job,
    productImporter,
    inventoryImporter,
    syncProducts,
    syncInventory,
    filters: options.filters || {},
    settings,
    validationOpts,
    syncLimit: ctx.import.syncLimit,
    skuAllowlist: ctx.import.skuAllowlist,
    onProgress: options.onProgress,
  });

  job.metrics.streamRowsRead = streamResult.rowsRead;

  if (client?.stats) {
    job.mergeClientStats(client.stats);
  }

  const summary = await job.finalize("completed");
  return { ...summary, stream: streamResult };
}

function applySettingsEnv(settings) {
  if (settings.ociostockCsvUrl && globalThis.process?.env) {
    globalThis.process.env.OCIOSTOCK_CSV_URL = settings.ociostockCsvUrl;
  }
  const { translateToEnglish, provider, apiKey } = resolveTranslationConfig(settings);
  if (translateToEnglish && globalThis.process?.env) {
    globalThis.process.env.TRANSLATION_PROVIDER = provider;
    if (apiKey) globalThis.process.env.TRANSLATION_API_KEY = apiKey;
  }
}

function parseAllowlist(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
