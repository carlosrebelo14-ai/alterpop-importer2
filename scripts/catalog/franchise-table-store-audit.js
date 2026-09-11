#!/usr/bin/env node
/**
 * BRIEFING BACKEND · Tarefa 25 — auditoria tabela contra loja.
 *
 * SÓ RELATÓRIO. Lista todas as entradas de franchiseUniverses.js (as 39) SEM coleção
 * correspondente na loja Shopify, e para cada uma conta quantos CatalogProduct têm
 * esse resolvedFranchise. A remoção decide-se à parte (com o Carlos) — este script
 * não apaga nada, não sugere nada.
 *
 * Correr na Fly:  node scripts/catalog/franchise-table-store-audit.js
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { FRANCHISE_UNIVERSES } from "../../lib/importer/catalog/franchiseUniverses.js";

const SHOP =
  (process.argv.indexOf("--shop") >= 0 && process.argv[process.argv.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";

const COLLECTIONS_QUERY = `
  query Audit_Colls($cursor: String) {
    collections(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { handle }
    }
  }
`;

async function fetchAllCollectionHandles(client) {
  const out = new Set();
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const data = await client.graphql(COLLECTIONS_QUERY, { cursor });
    const conn = data?.collections;
    for (const n of conn?.nodes || []) out.add(n.handle);
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}

async function main() {
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  console.log(`\n=== franchise-table-store-audit (${SHOP}) — Tarefa 25 ===\n`);

  const storeHandles = await fetchAllCollectionHandles(client);
  console.log(`coleções na loja: ${storeHandles.size}`);
  console.log(`entradas na tabela: ${FRANCHISE_UNIVERSES.length}\n`);

  const missing = FRANCHISE_UNIVERSES.filter((u) => !storeHandles.has(u.handle));
  console.log(`entradas da tabela SEM coleção correspondente na loja: ${missing.length}\n`);

  if (!missing.length) {
    console.log("(nenhuma — todas as entradas ativas/dormentes têm coleção, ou a tabela está alinhada)");
  } else {
    console.log(`${"handle".padEnd(28)} ${"nome".padEnd(28)} ${"ativo".padEnd(6)} ${"baseline".padStart(9)}  produtos com este resolvedFranchise`);
    for (const u of missing) {
      const count = await prisma.catalogProduct.count({ where: { shop: SHOP, resolvedFranchise: u.name } });
      console.log(
        `${u.handle.padEnd(28)} ${u.name.padEnd(28)} ${String(u.active).padEnd(6)} ${String(u.baseline).padStart(9)}  ${count}`
      );
    }
  }

  console.log(`\n(só relatório — nada apagado, nada decidido aqui)`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err?.stack || err?.message || err);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
