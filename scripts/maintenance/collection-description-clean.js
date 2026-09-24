// B14 (briefing backend, 24/09/2026), secção 3.
//
// A publicação automática no Online Store (secção 6) tira a revisão no Admin antes de o
// cliente ver a coleção. As 23 coleções corrigidas em 13/09 (fix-universe-collection-
// descriptions.mjs) já têm copy editorial (universeCollectionCopy.js); este script só
// limpa o que ainda tiver um dos dois placeholders internos (collectionDescriptionPlaceholder.js).
// Nunca toca em copy editorial nem em descrição vazia.
//
// Regra da secção 2: dry-run por omissão, escrita exige --execute. Reporta processadas e
// total; sai com erro se não baterem.
//
// Uso: node scripts/maintenance/collection-description-clean.js [--execute]
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { stripHtml, matchPlaceholder } from "../../lib/importer/shopify/collectionDescriptionPlaceholder.js";

const EXECUTE = process.argv.includes("--execute");
const SHOP = process.env.SHOPIFY_SHOP_URL;

// Número de referência do backfill de 13/09 (fix-universe-collection-descriptions.mjs).
const BASELINE_13_09_COUNT = 23;

const COLLECTIONS_PAGE = `
  query CleanDescPage($cursor: String) {
    collections(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id handle title descriptionHtml }
    }
  }
`;

const COLLECTION_UPDATE = `
  mutation CleanDescUpdate($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection { id handle }
      userErrors { field message }
    }
  }
`;

async function fetchAllCollections(client) {
  const out = [];
  let cursor = null;
  for (;;) {
    const data = await client.graphql(COLLECTIONS_PAGE, { cursor });
    const page = data.collections;
    out.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return out;
}

async function main() {
  if (!SHOP) throw new Error("SHOPIFY_SHOP_URL not set");
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  const all = await fetchAllCollections(client);
  const targetCount = all.filter((n) => matchPlaceholder(n.descriptionHtml)).length;

  console.log(
    `[collection-description-clean] loja: ${all.length} coleções lidas, ${targetCount} apanhadas (baseline 13/09: ${BASELINE_13_09_COUNT}, diferença: ${targetCount - BASELINE_13_09_COUNT})${EXECUTE ? "" : " (dry-run — nada escrito)"}`
  );

  let processed = 0;
  let cleaned = 0;
  let errorCount = 0;

  for (const node of all) {
    processed += 1;

    const match = matchPlaceholder(node.descriptionHtml);
    if (!match) continue;

    const preview = stripHtml(node.descriptionHtml).slice(0, 80);

    if (!EXECUTE) {
      console.log(
        `[collection-description-clean] (dry-run) limparia "${node.title}" (${node.handle}) — padrão=${match.name} — "${preview}"`
      );
      cleaned += 1;
      continue;
    }

    const res = await client.graphql(COLLECTION_UPDATE, {
      input: { id: node.id, descriptionHtml: "" },
    });
    const errs = res.collectionUpdate?.userErrors || [];
    if (errs.length) {
      errorCount += 1;
      console.error(`[collection-description-clean] userErrors em "${node.title}" (${node.handle}):`, errs);
    } else {
      cleaned += 1;
      console.log(`[collection-description-clean] limpo "${node.title}" (${node.handle})`);
    }
  }

  console.log(
    `[collection-description-clean] DONE. processed=${processed} total=${all.length} cleaned=${cleaned} errors=${errorCount}${EXECUTE ? "" : " (dry-run — nada escrito)"}`
  );

  if (processed !== all.length) {
    console.error(
      `[collection-description-clean] FATAL: processed (${processed}) != total (${all.length})`
    );
    process.exit(1);
  }
  if (errorCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[collection-description-clean] fatal:", err);
  process.exit(1);
});
