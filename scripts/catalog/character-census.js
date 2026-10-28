#!/usr/bin/env node
/**
 * PR 4 — census C (read-only) com limiar 1 (decisão do arquiteto, 27/10/2026).
 * Diz quantos Characters mudariam de estado na loja se o limiar fosse 1, e se a trava
 * de 10 por ciclo deixaria aplicar. Não escreve nada.
 *
 * Correr na Fly:  node scripts/catalog/character-census.js
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { planCharacterMetaobjects, CHARACTER_THRESHOLD } from "../../lib/importer/catalog/characterPages.server.js";
import { decideCharacterCycleAction, MAX_CHARACTER_CHANGES_PER_CYCLE } from "../../lib/importer/shopify/characterPagesReconcileCycle.server.js";
import { fetchActiveProducts, fetchExistingCharacters, buildLiveCounts, marcarUpdatesSemMudanca, resolverUniversosDosUpdates } from "../../lib/importer/shopify/characterPagesSync.server.js";

const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";

async function main() {
  console.log(`\n=== character-census (${SHOP}) · limiar ${CHARACTER_THRESHOLD} · read-only ===\n`);
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  const activeProducts = await fetchActiveProducts(client);
  const existing = await fetchExistingCharacters(client);
  const liveCounts = await buildLiveCounts(SHOP, activeProducts);
  const planned = planCharacterMetaobjects({ liveCounts, existing });
  const universeGidByName = await resolverUniversosDosUpdates(client, planned);
  const actions = marcarUpdatesSemMudanca(planned, existing, liveCounts, universeGidByName);
  const decision = decideCharacterCycleAction(actions);

  const byAction = {};
  for (const a of actions) byAction[a.action] = (byAction[a.action] || 0) + 1;
  console.log(`produtos ACTIVE: ${activeProducts.length} · metaobjects existentes: ${existing.size}`);
  console.log(`ações: ${JSON.stringify(byAction)}`);
  console.log(`\n-- Characters a mudar (create, reactivate, update, set-draft) --`);
  for (const a of actions.filter((x) => ["create", "reactivate", "update", "set-draft"].includes(x.action))) {
    console.log(`  ${a.action.padEnd(10)} ${a.handle.padEnd(24)} ${String(a.count).padStart(4)} produtos`);
  }
  for (const a of actions.filter((x) => x.action === "error")) console.log(`ERRO ${a.handle}: ${a.error}`);
  console.log(`\ntrava de ${MAX_CHARACTER_CHANGES_PER_CYCLE}: estado ${decision.status}`);
  if (decision.status === "red") {
    console.log(`  acima da trava. Primeira corrida pede OK do arquiteto para levantar a trava uma vez (A6).`);
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
