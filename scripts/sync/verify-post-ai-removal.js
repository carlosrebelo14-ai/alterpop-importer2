#!/usr/bin/env node
/**
 * Passo 5 (briefing 16/09/2026) — publish real de UM produto, de ponta a ponta, depois
 * de remover a chamada a curateWithAI e a chave GOOGLE_API_KEY. Reusa o SKU do Pikachu
 * do piloto (0030506556343, já publicado e estável — "Verificado, não mexer") em vez de
 * um SKU novo: uma resincronização idempotente, sem ação irreversível nova.
 *
 * CORREÇÃO (depois de tentar runImport/ProductImporter): esse é o caminho do IMPORTADOR
 * DO FEED (`/api/import/start`), travado por DRY_RUN=true nesta Fly — e não é sequer o
 * caminho real de "Carlos aprova no painel -> publica". Esse é
 * shopifyApprovedSync.server.js (`runApprovedShopifySync`, api.shopify-sync.jsx), que
 * nunca chamou curateWithAI e não depende de DRY_RUN. É esse que se verifica aqui.
 *
 * Correr na Fly: node scripts/sync/verify-post-ai-removal.js
 */
import { runApprovedShopifySync } from "../../lib/importer/shopify/shopifyApprovedSync.server.js";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { getCurationQueueEntry } from "../../lib/curation/curationQueue.server.js";

const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
const SKU = "0030506556343"; // Pikachu, um dos 8 do piloto

async function main() {
  const before = await getCurationQueueEntry(SKU);
  console.log(`=== Verificação pós-remoção de AI — SKU ${SKU} (${SHOP}) ===\n`);
  console.log(`Estado antes: status=${before?.status} shopifyStatus=${before?.shopifyStatus}\n`);

  const session = await loadOfflineSessionForShop(SHOP);
  const summary = await runApprovedShopifySync(session, { skus: [SKU] });

  console.log("\n=== Concluído sem lançar exceção ===");
  console.log(JSON.stringify(summary, null, 2));

  const after = await getCurationQueueEntry(SKU);
  console.log(`\nEstado depois: status=${after?.status} shopifyStatus=${after?.shopifyStatus}`);
}

main()
  .catch((err) => {
    console.error(`\nFALHOU: ${err?.stack || err?.message || err}`);
    process.exit(1);
  });
