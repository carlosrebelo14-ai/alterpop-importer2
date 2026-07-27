#!/usr/bin/env node
/**
 * Import live controlado (Opção A, passo 4) — requer DRY_RUN=false no .env e sessão OAuth em Prisma.
 *
 * Uso: node scripts/run-live-import.js [syncLimit]
 */
import { runImport } from "../lib/importer/jobs/runImport.js";
import { loadShopSettings } from "../lib/importer/settings.server.js";
import { assertLiveImportAllowed } from "../lib/importer/jobs/dryRunGuard.js";
import { getDefaultConfig } from "../lib/importer/config.js";
import { loadOfflineSessionForShop } from "../lib/session/loadOfflineSessionForShop.server.js";

const envLimit = parseInt(process.env.SYNC_LIMIT || "3", 10);
const limit = parseInt(process.argv[2] || String(envLimit), 10);

async function loadSession() {
  const shop =
    process.env.SPOT_CHECK_SHOP ||
    process.env.SHOPIFY_SHOP_URL ||
    process.env.SHOPIFY_STORE ||
    process.env.SHOPIFY_DEV_STORE ||
    "jyr17t-wr.myshopify.com";
  return loadOfflineSessionForShop(shop);
}

async function main() {
  assertLiveImportAllowed(false);

  const cfg = getDefaultConfig();
  console.log("=== Alterpop Live Import ===");
  console.log(`DRY_RUN=${cfg.import.dryRun} | SYNC_LIMIT=${limit} | shop via Prisma`);

  const session = await loadSession();
  const settings = await loadShopSettings(session.shop);
  Object.assign(settings, {
    syncLimit: limit,
    syncProducts: true,
    syncInventory: true,
    syncImages: true,
    syncPrices: true,
    translateToEnglish: false,
  });

  console.log(`Loja: ${session.shop}`);
  console.log("A iniciar stream + GraphQL…\n");

  const summary = await runImport({
    session,
    settings,
    dryRun: false,
  });

  console.log("\n=== Concluído ===");
  console.log(`Job: ${summary.jobId}`);
  console.log(`Métricas:`, JSON.stringify(summary.metrics, null, 2));
  console.log(`Relatórios: results/${summary.jobId}/`);
}

main()
  .catch((err) => {
    console.error(err?.stack || err?.message || err);
    process.exit(1);
  });
