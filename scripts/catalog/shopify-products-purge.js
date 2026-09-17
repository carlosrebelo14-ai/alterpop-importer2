#!/usr/bin/env node
/**
 * Esvaziar a loja Shopify — apagar TODOS os produtos (limpeza 2026-09-09, aprovada
 * pelo Carlos: "5575 produtos publicados são placeholder, a loja não está aberta ao
 * público, não há histórico a preservar").
 *
 * MODO STREAMING, memória constante. A primeira versão reutilizava
 * runShopifyCatalogReset (carrega os 5400+ produtos todos para um Map antes de
 * apagar) e fez OOM-kill na máquina de 512 MB (exit 137). Esta versão pagina e
 * apaga ao mesmo tempo: nunca segura mais do que PAGE ids de cada vez.
 *
 * RESUMÍVEL: cada corrida busca `products(first: PAGE)` (sem cursor — os apagados
 * saem da lista), apaga essa página, repete até `productsCount` chegar a 0. Se a
 * máquina reiniciar a meio, corre outra vez — continua de onde estava.
 *
 * No fim (loja a 0): reverte a fila local PUBLISHED/SYNC_ERROR → APPROVED e limpa
 * shopifyProductId (para republicação limpa pelo pipeline novo — Fase 6b escreve
 * alterpop.franchise no publish), e desativa os sync errors antigos.
 *
 * NÃO toca em coleções (já limpas), na definição alterpop.franchise, nem no
 * catálogo local indexado (CatalogProduct).
 *
 * DRY-RUN por defeito (só conta). `--execute` apaga.
 *
 * Precisa de sessão OAuth offline (correr na Fly):
 *   node scripts/catalog/shopify-products-purge.js            # dry-run (conta)
 *   node scripts/catalog/shopify-products-purge.js --execute
 *   node scripts/catalog/shopify-products-purge.js --execute --max 1000   # cap por corrida
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import {
  revertAllPublishedInQueue,
} from "../../lib/importer/shopify/shopifyReset.server.js";
import { deactivateAllSyncErrors } from "../../lib/importer/sync/syncErrorLog.server.js";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const MAX = (() => {
  const i = args.indexOf("--max");
  return i >= 0 && args[i + 1] ? Math.max(1, parseInt(args[i + 1], 10) || 0) : Infinity;
})();
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  process.env.SPOT_CHECK_SHOP ||
  "jyr17t-wr.myshopify.com";

const PAGE = 40;
const DELETE_DELAY_MS = 120;
const PAGE_DELAY_MS = 400;

const COUNT_QUERY = `query PurgeCount { productsCount { count } }`;

const PAGE_QUERY = `
  query PurgePage($first: Int!) {
    products(first: $first) {
      nodes { id }
    }
  }
`;

const DELETE_MUTATION = `
  mutation PurgeDelete($input: ProductDeleteInput!) {
    productDelete(input: $input) { deletedProductId userErrors { field message } }
  }
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function count(client) {
  const d = await client.graphql(COUNT_QUERY);
  return Number(d?.productsCount?.count) || 0;
}

async function main() {
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  const start = await count(client);
  console.log(`=== shopify-products-purge (${SHOP})${EXECUTE ? "" : " · DRY-RUN"} ===`);
  console.log(`produtos na loja: ${start}`);

  if (!EXECUTE) {
    console.log(`\nDRY-RUN — nada apagado. Corre com --execute.`);
    return;
  }
  if (start === 0) {
    console.log(`\nLoja já vazia.`);
    await finalize(client);
    return;
  }

  console.log(`\n=== a apagar${MAX !== Infinity ? ` até ${MAX}` : ""} · página de ${PAGE} ===`);
  const t0 = Date.now();
  let deleted = 0;
  let failed = 0;

  while (deleted < MAX) {
    const data = await client.graphql(PAGE_QUERY, { first: Math.min(PAGE, MAX - deleted) });
    const nodes = data?.products?.nodes || [];
    if (nodes.length === 0) break;

    for (const n of nodes) {
      try {
        const res = await client.graphql(DELETE_MUTATION, { input: { id: n.id } });
        const errs = res.productDelete?.userErrors || [];
        if (errs.length || !res.productDelete?.deletedProductId) {
          failed++;
          if (failed <= 20) console.warn(`  ✗ ${n.id}: ${errs.map((e) => e.message).join("; ") || "sem id"}`);
        } else {
          deleted++;
        }
      } catch (err) {
        failed++;
        if (failed <= 20) console.warn(`  ✗ ${n.id}: ${err?.message || err}`);
      }
      await sleep(DELETE_DELAY_MS);
    }

    const remaining = await count(client);
    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    console.log(`  apagados ${deleted} · falhas ${failed} · restam ${remaining} · ${mins} min`);
    if (remaining === 0) break;
    await sleep(PAGE_DELAY_MS);
  }

  const end = await count(client);
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`\nconcluído em ${mins} min · apagados ${deleted} · falhas ${failed} · produtos na loja agora: ${end}`);

  if (end === 0) {
    await finalize(client);
  } else {
    console.log(`⚠️  ainda restam ${end} — reexecuta --execute (a máquina pode ter reiniciado; é resumível).`);
    process.exit(1);
  }
}

async function finalize(client) {
  try {
    const reverted = await revertAllPublishedInQueue();
    console.log(`fila local: ${reverted} item(s) PUBLISHED/SYNC_ERROR → APPROVED (shopifyProductId limpo).`);
  } catch (err) {
    console.warn(`revert da fila local falhou: ${err?.message || err}`);
  }
  try {
    await deactivateAllSyncErrors(SHOP);
    console.log(`sync errors antigos desativados.`);
  } catch (err) {
    console.warn(`deactivateAllSyncErrors falhou: ${err?.message || err}`);
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
