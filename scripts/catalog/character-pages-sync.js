#!/usr/bin/env node
/**
 * B7 (briefing backend, 17/09/2026) — character-pages-sync.js, secção 6/8 passo 5-6.
 *
 * Aplica characterPages.server.js (puro) ao estado real da loja: lê os SKUs ACTIVE
 * (Online Store), cruza com `resolvedCharacters`/`resolvedFranchise` do Prisma, lê os
 * metaobjects `character` já existentes, e decide create/reactivate/update/set-draft/skip
 * por handle — nunca apaga um metaobject, nunca trunca `products` acima de 128.
 *
 * DRY-RUN por defeito: só relata as ações previstas. `--execute` escreve:
 *  - metaobjectUpsert (create/reactivate/update/set-draft) — NUNCA productUpdate.
 *  - `alterpop.character` nos produtos afetados (metafieldsSet), só para handles ACTIVE.
 *  - `alterpop.characters` nas coleções Universe tocadas (metafieldsSet), ACTIVE do
 *    universo, do maior para o menor número de produtos.
 *
 * A I/O (queries/mutações Shopify + cruzamento com o Prisma) vive em
 * characterPagesSync.server.js, partilhada com o ciclo automático do trigger-sync
 * (characterPagesReconcileCycle.server.js) — este script só é a casca de CLI/dry-run.
 *
 * Correr na Fly:  node scripts/catalog/character-pages-sync.js
 *                 node scripts/catalog/character-pages-sync.js --execute
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import {
  planCharacterMetaobjects,
  planUniverseCharacterCollections,
  CHARACTER_PRODUCTS_MAX,
} from "../../lib/importer/catalog/characterPages.server.js";
import {
  fetchActiveProducts,
  fetchExistingCharacters,
  buildLiveCounts,
  applyCharacterActions,
} from "../../lib/importer/shopify/characterPagesSync.server.js";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";

function reportActions(actions) {
  console.log(`\n── ações previstas (${actions.length} handles) ──`);
  const relevant = actions.filter((a) => a.action !== "skip");
  if (!relevant.length) {
    console.log(`  (nenhuma — tudo skip)`);
  }
  for (const a of relevant) {
    const linha = `  ${a.action.padEnd(10)} ${a.handle.padEnd(20)} ${(a.universo || "∅").padEnd(14)} ${String(a.count).padStart(4)} produtos`;
    if (a.action === "error") {
      console.log(`${linha}  ⚠ ${a.error}`);
    } else {
      console.log(linha);
    }
  }
  const skipped = actions.filter((a) => a.action === "skip");
  console.log(`\n  skip (nunca teve metaobject, abaixo do limiar): ${skipped.length} handles`);
}

function reportCollectionsPlan(plan) {
  console.log(`\n── alterpop.characters previsto por universo ──`);
  if (!plan.size) {
    console.log(`  (nenhum universo com Character ACTIVE)`);
    return;
  }
  for (const [universo, handles] of plan) {
    console.log(`  ${universo}: [${handles.join(", ")}]`);
  }
}

async function dryRun() {
  console.log(`\n=== character-pages-sync (${SHOP}) · DRY-RUN ===\n`);

  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  const activeProducts = await fetchActiveProducts(client);
  console.log(`produtos ACTIVE na loja: ${activeProducts.length}`);

  const existing = await fetchExistingCharacters(client);
  console.log(`metaobjects "character" já existentes: ${existing.size}`);

  const liveCounts = await buildLiveCounts(SHOP, activeProducts);
  const actions = planCharacterMetaobjects({ liveCounts, existing });
  reportActions(actions);

  const collectionsPlan = planUniverseCharacterCollections(actions);
  reportCollectionsPlan(collectionsPlan);

  const errors = actions.filter((a) => a.action === "error");
  console.log(`\n(nada escrito — dry-run.)`);
  if (errors.length) {
    throw new Error(`${errors.length} handle(s) acima do limite de ${CHARACTER_PRODUCTS_MAX} produtos — ver acima`);
  }
}

async function execute() {
  console.log(`\n=== character-pages-sync (${SHOP}) · --execute ===\n`);

  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  const activeProducts = await fetchActiveProducts(client);
  const existing = await fetchExistingCharacters(client);
  const liveCounts = await buildLiveCounts(SHOP, activeProducts);
  const actions = planCharacterMetaobjects({ liveCounts, existing });
  reportActions(actions);

  const errors = actions.filter((a) => a.action === "error");
  if (errors.length) {
    throw new Error(`${errors.length} handle(s) acima do limite de ${CHARACTER_PRODUCTS_MAX} produtos — corrigido à mão antes de --execute`);
  }

  const actionsToApply = actions.filter((a) => a.action !== "skip" && a.action !== "error");
  const result = await applyCharacterActions(client, { actionsToApply, liveCounts, existing, activeProducts });

  for (const a of result.applied) {
    if (a.targetStatus === "ACTIVE") {
      console.log(`  ${a.action.padEnd(10)} ${a.handle}  →  ${a.gid}  (${a.count} produtos)`);
    } else {
      console.log(`  ${a.action.padEnd(10)} ${a.handle}  →  DRAFT (referências removidas dos produtos)`);
    }
  }
  console.log(`\nalterpop.character escrito em ${result.productWrites} produto(s)`);
  for (const c of result.collectionsWritten) {
    console.log(`  alterpop.characters(${c.universo}) = [${c.handles.join(", ")}]`);
  }
  console.log(`\nalterpop.characters escrito em ${result.collectionWrites} coleção/coleções`);
}

async function main() {
  if (EXECUTE) await execute();
  else await dryRun();
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
