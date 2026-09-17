#!/usr/bin/env node
/**
 * B18 item 5 (briefing backend, 17/09/2026) — live-title-reconcile.js.
 *
 * Caminho próprio para corrigir TÍTULOS já live. publishedStockSync nunca chama
 * productUpdate, por desenho (stock e só stock) — este script é o único caminho que
 * escreve title na loja fora da via APPROVED normal do publisher.
 *
 * DRY-RUN por omissão. `--execute` grava, e SÓ o campo `title` via productUpdate —
 * nunca vendor/descriptionHtml/status/tags/category, nunca handle.
 *
 * Regra de segurança (edição manual): se o título ATUAL na loja for diferente de
 * `CatalogProduct.lastPublishedTitle` (o que o publisher escreveu da última vez), foi o
 * Carlos que editou à mão depois disso — o produto é SALTADO e reportado, nunca
 * sobrescrito. lastPublishedTitle NULL (nunca publicado por este caminho) conta como
 * seguro para reconciliar.
 *
 * Não resolve TITLE_DUPLICATE genuíno de feed (os dois "Star Wars Luke Skywalker" têm
 * originalTitle byte-a-byte igual — o esperado já É o live, não há para onde
 * reconciliar). Isso é decisão de curadoria, não deste script.
 *
 * Correr na Fly:
 *   node scripts/catalog/live-title-reconcile.js
 *   node scripts/catalog/live-title-reconcile.js --execute
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { prisma, safePrisma } from "../../lib/prisma/prismaSafe.server.js";
import { buildPublishPayload } from "../../lib/importer/shopify/shopifyMapper.server.js";

const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
const EXECUTE = process.argv.includes("--execute");

const ACTIVE_PRODUCTS_QUERY = `
  query ReconcileActive($cursor: String) {
    products(first: 250, after: $cursor, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        title
        variants(first: 1) { nodes { sku } }
      }
    }
  }
`;

const TITLE_UPDATE = `
  mutation ReconcileTitleUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id title }
      userErrors { field message }
    }
  }
`;

async function fetchAllActive(client) {
  const out = [];
  let cursor = null;
  for (;;) {
    const data = await client.graphql(ACTIVE_PRODUCTS_QUERY, { cursor });
    const conn = data?.products;
    for (const n of conn?.nodes || []) out.push(n);
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}

async function main() {
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  console.log(`\n=== live-title-reconcile (${SHOP}) · ${EXECUTE ? "EXECUTE" : "DRY-RUN"} ===\n`);

  const activeNodes = await fetchAllActive(client);
  console.log(`produtos ACTIVE: ${activeNodes.length}\n`);

  let alreadyCorrect = 0;
  let skippedNoCatalogRow = 0;
  let manualEditSkipped = 0;
  let toReconcile = 0;
  let updated = 0;
  const manualEdits = [];
  const reconciled = [];

  for (const node of activeNodes) {
    const sku = node.variants?.nodes?.[0]?.sku || null;
    if (!sku) continue;

    const row = await prisma.catalogProduct.findFirst({ where: { shop: SHOP, sku } });
    if (!row) {
      skippedNoCatalogRow += 1;
      continue;
    }

    const payload = await buildPublishPayload(row);
    const desired = payload.title;
    const live = node.title;

    if (desired === live) {
      alreadyCorrect += 1;
      continue;
    }

    const lastPublished = row.lastPublishedTitle;
    if (lastPublished && lastPublished !== live) {
      manualEditSkipped += 1;
      manualEdits.push({ sku, handle: node.handle, live, lastPublished, desired });
      continue;
    }

    toReconcile += 1;
    reconciled.push({ sku, handle: node.handle, id: node.id, live, desired });

    if (EXECUTE) {
      const data = await client.graphql(TITLE_UPDATE, { input: { id: node.id, title: desired } });
      const errors = data.productUpdate?.userErrors || [];
      if (errors.length) {
        console.error(`  ✗ ${sku} (${node.handle}): ${errors.map((e) => e.message).join("; ")}`);
        continue;
      }
      await safePrisma(
        "liveTitleReconcile.lastPublishedTitle",
        () =>
          prisma.catalogProduct.update({
            where: { shop_sku: { shop: SHOP, sku } },
            data: { lastPublishedTitle: desired },
          }),
        { rethrow: false }
      );
      updated += 1;
    }
  }

  if (manualEdits.length) {
    console.log(`── edição manual detetada, SALTADOS (${manualEdits.length}) ──`);
    for (const m of manualEdits) {
      console.log(`  ${m.sku}  ${m.handle}`);
      console.log(`    live:            ${JSON.stringify(m.live)}`);
      console.log(`    lastPublished:   ${JSON.stringify(m.lastPublished)}`);
      console.log(`    seria (ignorado):${JSON.stringify(m.desired)}`);
    }
    console.log();
  }

  if (reconciled.length) {
    console.log(`── ${EXECUTE ? "atualizados" : "seriam atualizados"} (${reconciled.length}) ──`);
    for (const r of reconciled) {
      console.log(`  ${r.sku}  ${r.handle}`);
      console.log(`    live:  ${JSON.stringify(r.live)}`);
      console.log(`    novo:  ${JSON.stringify(r.desired)}`);
    }
    console.log();
  }

  console.log(
    `=== DONE. ativos=${activeNodes.length} já_correto=${alreadyCorrect} sem_linha_prisma=${skippedNoCatalogRow} ` +
      `edicao_manual_saltados=${manualEditSkipped} ${EXECUTE ? "atualizados" : "a_reconciliar"}=${EXECUTE ? updated : toReconcile} ===`
  );
  if (!EXECUTE && toReconcile > 0) {
    console.log(`\n(nada escrito — dry-run. Corre com --execute depois da aprovação do Carlos.)`);
  }
}

main()
  .catch((err) => {
    console.error("[live-title-reconcile] fatal:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
