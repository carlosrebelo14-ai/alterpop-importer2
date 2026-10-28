#!/usr/bin/env node
/**
 * PR 4b — primeiro ciclo de personagens com a trava levantada UMA vez (decisão do arquiteto,
 * 27/10/2026). Só existe em fly-ops (comando cycle-apply-once), com environment production.
 *
 * Calcula o plano a partir de ProductCharacter, imprime-o e só depois escreve. Aborta sem
 * escrever se houver ação fora das classes autorizadas (lib/importer/catalog/characterCycleAllowlist.js).
 * A trava normal de MAX_CHARACTER_CHANGES_PER_CYCLE continua a valer para os ciclos seguintes.
 *
 * Correr na Fly:  node scripts/catalog/character-cycle-apply-once.js
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { planCharacterMetaobjects } from "../../lib/importer/catalog/characterPages.server.js";
import { classificarAcoesAutorizadas } from "../../lib/importer/catalog/characterCycleAllowlist.js";
import {
  fetchActiveProducts,
  fetchExistingCharacters,
  buildLiveCounts,
  applyCharacterActions,
} from "../../lib/importer/shopify/characterPagesSync.server.js";

const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";

async function main() {
  console.log(`\n=== character-cycle-apply-once (${SHOP}) · trava levantada uma vez ===\n`);
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  const activeProducts = await fetchActiveProducts(client);
  const existing = await fetchExistingCharacters(client);
  const liveCounts = await buildLiveCounts(SHOP, activeProducts);
  const actions = planCharacterMetaobjects({ liveCounts, existing });

  const erros = actions.filter((a) => a.action === "error");
  if (erros.length) throw new Error(`${erros.length} handle(s) com erro no plano (>128 produtos) — nada escrito`);

  const { permitidas, fora } = classificarAcoesAutorizadas(actions);
  console.log(`ações previstas (${permitidas.length} autorizadas, ${fora.length} fora):`);
  for (const a of permitidas) console.log(`  ${a.action.padEnd(10)}\t${a.handle}\t${a.count} produtos`);
  for (const f of fora) console.log(`  FORA\t${f.action}\t${f.handle}\t${f.motivo}`);

  if (fora.length) {
    throw new Error(`abortado: ${fora.length} ação(ões) fora das classes autorizadas — nada escrito`);
  }
  if (!permitidas.length) {
    console.log("nada a aplicar. nada escrito.");
  } else {
    const result = await applyCharacterActions(client, { actionsToApply: permitidas, liveCounts, existing, activeProducts });
    console.log(`\naplicado: ${result.applied.length} personagem(ns), ${result.productWrites} produto(s), ${result.collectionWrites} coleção/coleções`);
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
