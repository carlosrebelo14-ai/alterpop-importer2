#!/usr/bin/env node
/**
 * Passo 5 (briefing 16/09/2026) — publish real de UM produto, de ponta a ponta, depois
 * de remover a chamada a curateWithAI e a chave GOOGLE_API_KEY. Reusa o SKU do Pikachu
 * do piloto (0030506556343, já publicado e estável — "Verificado, não mexer") em vez de
 * um SKU novo: uma resincronização idempotente, sem ação irreversível nova.
 *
 * Correr na Fly: node scripts/sync/verify-post-ai-removal.js
 */
import { runImport } from "../../lib/importer/jobs/runImport.js";
import { loadShopSettings } from "../../lib/importer/settings.server.js";
import { assertLiveImportAllowed } from "../../lib/importer/jobs/dryRunGuard.js";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";

const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
const SKU = "0030506556343"; // Pikachu, um dos 8 do piloto

async function main() {
  assertLiveImportAllowed(false);

  const session = await loadOfflineSessionForShop(SHOP);
  const settings = await loadShopSettings(session.shop);
  Object.assign(settings, {
    syncLimit: 1,
    skuAllowlist: [SKU],
    syncProducts: true,
    syncInventory: true,
    syncImages: true,
    syncPrices: true,
    translateToEnglish: false,
  });

  console.log(`=== Verificação pós-remoção de AI — SKU ${SKU} (${SHOP}) ===\n`);
  const summary = await runImport({ session, settings, dryRun: false });

  console.log("\n=== Concluído sem lançar exceção ===");
  console.log(`Job: ${summary.jobId}`);
  console.log(`Métricas:`, JSON.stringify(summary.metrics, null, 2));
}

main()
  .catch((err) => {
    console.error(`\nFALHOU: ${err?.stack || err?.message || err}`);
    process.exit(1);
  });
