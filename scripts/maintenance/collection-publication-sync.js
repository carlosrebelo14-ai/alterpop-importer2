// B14 (briefing backend, 24/09/2026), secção 7.
//
// Reconciliação sobre as coleções JÁ EXISTENTES (Universe/Line) — pega no que a
// publicação-na-criação (collectionPublication.server.js) não cobre: coleções criadas
// antes deste ciclo, ou perdidas por um erro pontual. Corre as mesmas guardas de início
// de ciclo (scopes + publicationId) e o mesmo plano de reconciliação puro
// (planReconciliation) que o futuro V14 do trigger-sync vai usar.
//
// Verificação do estado: paginado, sem chamada por coleção e sem
// resourcePublications(first: 10) — que corta nas coleções antigas com 7 canais.
//
// Regra da secção 2: dry-run por omissão, escrita exige --execute. Reporta processadas
// e total; sai com erro se não baterem.
//
// Uso: node scripts/maintenance/collection-publication-sync.js [--execute]
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import {
  ONLINE_STORE_PUBLICATION_ID,
  MAX_AUTO_PUBLISH,
  checkCyclePreconditions,
  planReconciliation,
} from "../../lib/importer/shopify/collectionPublication.server.js";
import { UNIVERSE_TEMPLATE_SUFFIX } from "../../lib/importer/catalog/franchiseUniverses.js";
import { LINE_TEMPLATE_SUFFIX } from "../../lib/importer/catalog/franchiseLines.js";
import { checkSupplierTokens } from "../../lib/importer/curation/prePublishChecks.server.js";

const EXECUTE = process.argv.includes("--execute");
const SHOP = process.env.SHOPIFY_SHOP_URL;

const IN_SCOPE_TEMPLATE_SUFFIXES = new Set([UNIVERSE_TEMPLATE_SUFFIX, LINE_TEMPLATE_SUFFIX]);

const COLLECTIONS_PAGE = `
  query CollPubSyncPage($pub: ID!, $after: String) {
    collections(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        title
        templateSuffix
        descriptionHtml
        productsCount { count }
        publishedOnPublication(publicationId: $pub)
      }
    }
  }
`;

const PUBLISH_MUTATION = `
  mutation CollPubSyncPublish($id: ID!, $pub: ID!) {
    publishablePublish(id: $id, input: [{ publicationId: $pub }]) {
      userErrors { field message }
    }
  }
`;

async function fetchInScopeCollections(client, publicationId) {
  const out = [];
  let cursor = null;
  for (;;) {
    const data = await client.graphql(COLLECTIONS_PAGE, { pub: publicationId, after: cursor });
    const page = data.collections;
    for (const node of page.nodes) {
      if (IN_SCOPE_TEMPLATE_SUFFIXES.has(node.templateSuffix)) {
        out.push({ ...node, productsCount: node.productsCount?.count ?? null });
      }
    }
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return out;
}

async function main() {
  if (!SHOP) throw new Error("SHOPIFY_SHOP_URL not set");
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  const preconditions = await checkCyclePreconditions(client, ONLINE_STORE_PUBLICATION_ID);
  if (!preconditions.ok) {
    console.error(`[collection-publication-sync] FATAL: ${preconditions.reason}. Publicação saltada, nada tocado.`);
    process.exit(1);
  }

  const collections = await fetchInScopeCollections(client, ONLINE_STORE_PUBLICATION_ID);
  const plan = planReconciliation(collections);

  console.log(
    `[collection-publication-sync] loja: ${collections.length} coleção(ões) em âmbito (templateSuffix universe-room/line)${EXECUTE ? "" : " (dry-run — nada escrito)"}`
  );
  for (const c of plan.classified) {
    console.log(`[collection-publication-sync]   ${c.handle} — status=${c.status ?? "?"} publicada=${!!c.publishedOnPublication} produtos=${c.productsCount ?? "?"} -> ${c.action}`);
  }

  if (plan.brakeTriggered) {
    const overLimit = plan.classified.filter((c) => c.action === "publish");
    console.error(
      `[collection-publication-sync] TRAVÃO: ${overLimit.length} por publicar, acima de MAX_AUTO_PUBLISH (${MAX_AUTO_PUBLISH}). Não publica nenhuma. Lista: ${overLimit.map((c) => c.handle).join(", ")}`
    );
  }

  console.log(`[collection-publication-sync] ações previstas: publish=${plan.toPublish.length} register-only=${plan.classified.filter((c) => c.action === "register-only").length} noop=${plan.classified.filter((c) => c.action === "noop").length} unknown-universe=${plan.classified.filter((c) => c.action === "unknown-universe").length}`);

  let processed = 0;
  let published = 0;
  let errorCount = 0;

  for (const c of plan.toPublish) {
    processed += 1;

    if (!EXECUTE) {
      console.log(`[collection-publication-sync] (dry-run) publicaria "${c.title}" (${c.handle})`);
      published += 1;
      continue;
    }

    const warning = checkSupplierTokens({ descriptionHtml: c.descriptionHtml });
    if (warning) {
      console.warn(`[collection-publication-sync] aviso em "${c.title}" (${c.handle}): ${warning.message} — publica na mesma.`);
    }

    const res = await client.graphql(PUBLISH_MUTATION, { id: c.id, pub: ONLINE_STORE_PUBLICATION_ID });
    const errs = res.publishablePublish?.userErrors || [];
    if (errs.length) {
      errorCount += 1;
      console.error(`[collection-publication-sync] userErrors ao publicar "${c.title}" (${c.handle}):`, errs);
    } else {
      published += 1;
      console.log(`[collection-publication-sync] publicada "${c.title}" (${c.handle}).`);
    }
  }

  console.log(
    `[collection-publication-sync] DONE. processed=${processed} total=${plan.toPublish.length} published=${published} errors=${errorCount}${EXECUTE ? "" : " (dry-run — nada escrito)"}`
  );

  if (processed !== plan.toPublish.length) {
    console.error(
      `[collection-publication-sync] FATAL: processed (${processed}) != total (${plan.toPublish.length})`
    );
    process.exit(1);
  }
  if (errorCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[collection-publication-sync] fatal:", err);
  process.exit(1);
});
