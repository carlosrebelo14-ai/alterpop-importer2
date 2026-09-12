#!/usr/bin/env node
/**
 * Tarefa 40 — verificação pós-wipe, portão obrigatório antes da Tarefa 48 (publicação
 * do lote piloto).
 *
 * SÓ RELATÓRIO — read-only, não escreve nada. V1–V10 na ordem do briefing; qualquer
 * falha faz sair com exit code 1 e a Tarefa 48 não deve correr.
 *
 * V4 é a crítica: `shopifyProductId` órfão (aponta para um produto apagado no wipe)
 * faz o publisher tentar `productUpdate` em vez de `productCreate` e falhar com 404
 * no piloto inteiro.
 *
 * Tarefa 49 (2026-09-13) — V6 e V8 corrigidos. A primeira versão (Tarefa 40) tinha as
 * DUAS mal calibradas contra o comportamento real, não contra os dados:
 *   V6  era "cleanTitle IS NOT NULL = 854" — mas a Tarefa 10 grava cleanTitle no
 *       catálogo INTEIRO desde o primeiro --execute (cópia de title quando não há
 *       alteração), por desenho nunca fica NULL fora das linhas ainda não passadas
 *       pelo backfill. Passa a "cleanTitle <> title", em INTERVALO 800–900 (não valor
 *       cravado — o feed muda entre corridas, um valor fixo transformava reindexação
 *       normal em falso alarme).
 *   V8  era "coleções na loja = 35" — mas a loja tem coleções fora do âmbito do
 *       resolver (ex.: new-arrivals, janela published_at, sem templateSuffix de
 *       universo/line). Passa a contar só coleções com templateSuffix ∈
 *       {UNIVERSE_TEMPLATE_SUFFIX, LINE_TEMPLATE_SUFFIX} — as únicas que a guarda
 *       (V9) e a tabela de franquias realmente governam.
 *
 * Correr na Fly:  node scripts/catalog/pre-pilot-verify.js
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { listCurationQueueItems } from "../../lib/curation/curationQueue.server.js";
import { assertFranchiseConditionsAligned } from "../../lib/importer/shopify/franchiseConditionsGuard.server.js";
import { UNIVERSE_TEMPLATE_SUFFIX } from "../../lib/importer/catalog/franchiseUniverses.js";
import { LINE_TEMPLATE_SUFFIX } from "../../lib/importer/catalog/franchiseLines.js";
import {
  ALTERPOP_FRANCHISE_DEFINITION_GID,
  ALTERPOP_LINE_DEFINITION_GID,
  ALTERPOP_FORMAT_DEFINITION_GID,
} from "../../lib/importer/shopify/franchiseMetafieldDefinition.js";

const GOVERNED_TEMPLATE_SUFFIXES = new Set([UNIVERSE_TEMPLATE_SUFFIX, LINE_TEMPLATE_SUFFIX]);

const args = process.argv.slice(2);
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";

const PRODUCTS_COUNT_QUERY = `query { productsCount { count } }`;
const METAFIELD_DEFS_QUERY = `
  query { metafieldDefinitions(first: 10, ownerType: PRODUCT, namespace: "alterpop") { nodes { id key } } }
`;
const COLLECTIONS_PAGE_QUERY = `
  query CollCount($cursor: String) {
    collections(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id handle templateSuffix }
    }
  }
`;

/** Tarefa 49 — só conta coleções que a tabela de franquias governa (universo/line).
 *  Coleções fora do âmbito (ex.: new-arrivals) ficam de fora por desenho. */
async function countGovernedCollections(client) {
  let count = 0;
  let cursor = null;
  for (let p = 0; p < 20; p++) {
    const data = await client.graphql(COLLECTIONS_PAGE_QUERY, { cursor });
    const conn = data?.collections;
    for (const node of conn?.nodes || []) {
      if (GOVERNED_TEMPLATE_SUFFIXES.has(node.templateSuffix)) count += 1;
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return count;
}

const results = [];
function check(id, label, expected, actual, pass) {
  results.push({ id, label, expected, actual, pass });
  const mark = pass ? "✓" : "✗";
  console.log(`  ${mark} ${id}  ${label} — esperado ${expected}, obtido ${actual}`);
}

/** V6 — intervalo, não valor cravado (Tarefa 49). */
function checkRange(id, label, min, max, actual) {
  const pass = actual >= min && actual <= max;
  check(id, label, `${min}–${max}`, actual, pass);
}

async function main() {
  console.log(`\n=== pre-pilot-verify (${SHOP}) — Tarefa 40 ===\n`);

  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  // V1 — produtos na loja
  const productsCount = (await client.graphql(PRODUCTS_COUNT_QUERY))?.productsCount?.count ?? null;
  check("V1", "produtos na loja", 0, productsCount, productsCount === 0);

  // V2/V3 — status da fila de curadoria
  const published = await listCurationQueueItems("PUBLISHED");
  check("V2", "fila status=PUBLISHED", 0, published.length, published.length === 0);

  const approved = await listCurationQueueItems("APPROVED");
  check("V3", "fila status=APPROVED", 0, approved.length, approved.length === 0);

  // V4 — shopifyProductId órfão (a crítica)
  const allItems = await listCurationQueueItems();
  const withShopifyId = allItems.filter((i) => i.metadata?.shopifyProductId != null);
  check("V4", "fila com shopifyProductId preenchido", 0, withShopifyId.length, withShopifyId.length === 0);
  if (withShopifyId.length) {
    console.log(`      SKUs órfãos: ${withShopifyId.slice(0, 10).map((i) => i.sku).join(", ")}${withShopifyId.length > 10 ? "…" : ""}`);
  }

  // V5–V7 — Prisma CatalogProduct
  const totalProducts = await prisma.catalogProduct.count({ where: { shop: SHOP } });
  check("V5", "CatalogProduct total", 25421, totalProducts, totalProducts === 25421);

  const cleanTitleDiffRows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) as c FROM CatalogProduct WHERE shop = ? AND cleanTitle IS NOT NULL AND cleanTitle <> title`,
    SHOP
  );
  const cleanTitleDiffCount = Number(cleanTitleDiffRows?.[0]?.c ?? 0);
  checkRange("V6", "cleanTitle <> title", 800, 900, cleanTitleDiffCount);

  const resolvedFormatCount = await prisma.catalogProduct.count({ where: { shop: SHOP, resolvedFormat: { not: null } } });
  check("V7", "resolvedFormat IS NOT NULL", 14183, resolvedFormatCount, resolvedFormatCount === 14183);

  // V8 — coleções governadas pela tabela de franquias (universo/line), não todas as
  // coleções da loja — new-arrivals e afins ficam de fora por desenho (Tarefa 49).
  const governedCollectionsCount = await countGovernedCollections(client);
  check("V8", "coleções com templateSuffix universo/line", 35, governedCollectionsCount, governedCollectionsCount === 35);

  // V9 — guarda de condições de franquia
  let v9Pass = false;
  try {
    await assertFranchiseConditionsAligned(client);
    v9Pass = true;
  } catch (err) {
    console.log(`      ${err?.message || err}`);
  }
  check("V9", "franchise:conditions-diff", "✓ tudo alinhado", v9Pass ? "✓ tudo alinhado" : "✗ desalinhado", v9Pass);

  // V10 — definições de metafield
  const defs = (await client.graphql(METAFIELD_DEFS_QUERY))?.metafieldDefinitions?.nodes || [];
  check("V10", "definições de metafield alterpop.*", 3, defs.length, defs.length === 3);
  if (defs.length !== 3) {
    console.log(`      encontradas: ${defs.map((d) => d.key).join(", ") || "nenhuma"}`);
    console.log(
      `      GIDs esperados: franchise=${ALTERPOP_FRANCHISE_DEFINITION_GID}, line=${ALTERPOP_LINE_DEFINITION_GID}, format=${ALTERPOP_FORMAT_DEFINITION_GID}`
    );
  }

  console.log(``);
  const allPass = results.every((r) => r.pass);
  const failed = results.filter((r) => !r.pass);
  if (allPass) {
    console.log(`✓ V1–V10 todas verdes. Tarefa 48 pode correr.`);
  } else {
    console.log(`✗ ${failed.length} verificação(ões) falhou/falharam: ${failed.map((r) => r.id).join(", ")}.`);
    console.log(`  Tarefa 48 TRAVADA — não corre com falhas pendentes.`);
  }

  await prisma.$disconnect();
  process.exit(allPass ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err?.stack || err?.message || err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
