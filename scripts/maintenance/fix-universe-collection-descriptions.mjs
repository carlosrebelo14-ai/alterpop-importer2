// Ferramenta de manutenção pontual — B14 (briefing 16/09/2026).
//
// universeCollections.server.js gravava um placeholder interno em descriptionHtml
// ("Coleção Universe — produtos com alterpop.franchise = ... Rascunho: confirmar e
// publicar no Admin.") em 21 coleções live; Batman e Toy Story tinham o placeholder
// mais antigo de autoCollections.server.js ("Coleção criada automaticamente...").
// The Mandalorian tinha o mesmo placeholder de universo mas já não é universo (ver
// franchiseLines.js) — corrige-se à parte, com texto próprio.
//
// A correção do gerador (universeCollections.server.js) evita que isto se repita para
// coleções futuras; este script só corrige o que já está publicado.
//
// Uso: node scripts/maintenance/fix-universe-collection-descriptions.mjs [--dry-run]
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { UNIVERSE_COLLECTION_COPY, MANDALORIAN_LINE_COPY } from "../../lib/importer/shopify/universeCollectionCopy.js";

const DRY_RUN = process.argv.includes("--dry-run");
const SHOP = process.env.SHOPIFY_SHOP_URL;

const OLD_PLACEHOLDER_RE = /^Coleção criada automaticamente/;
const NEW_PLACEHOLDER_RE = /^Coleção Universe — produtos com alterpop\.franchise/;

const COLLECTIONS_PAGE = `
  query FixDescPage($cursor: String) {
    collections(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id handle title descriptionHtml }
    }
  }
`;

const COLLECTION_UPDATE = `
  mutation FixDescUpdate($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection { id handle }
      userErrors { field message }
    }
  }
`;

function targetCopyFor(node) {
  if (node.handle === "the-mandalorian") return MANDALORIAN_LINE_COPY;
  return UNIVERSE_COLLECTION_COPY[node.title] || null;
}

function needsFix(html) {
  return OLD_PLACEHOLDER_RE.test(html || "") || NEW_PLACEHOLDER_RE.test(html || "");
}

async function main() {
  if (!SHOP) throw new Error("SHOPIFY_SHOP_URL not set");
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  let cursor = null;
  let scanned = 0;
  let fixedCount = 0;
  let skippedNoCopy = 0;
  let errorCount = 0;

  for (;;) {
    const data = await client.graphql(COLLECTIONS_PAGE, { cursor });
    const page = data.collections;

    for (const node of page.nodes) {
      scanned += 1;
      if (!needsFix(node.descriptionHtml)) continue;

      const copy = targetCopyFor(node);
      if (!copy) {
        skippedNoCopy += 1;
        console.warn(`[fix-universe-desc] sem cópia curada para "${node.title}" (${node.handle}) — não tocado`);
        continue;
      }

      if (DRY_RUN) {
        fixedCount += 1;
        console.log(`[fix-universe-desc] (dry-run) fixaria "${node.title}" (${node.handle})`);
        continue;
      }

      const res = await client.graphql(COLLECTION_UPDATE, {
        input: { id: node.id, descriptionHtml: copy },
      });
      const errs = res.collectionUpdate?.userErrors || [];
      if (errs.length) {
        errorCount += 1;
        console.error(`[fix-universe-desc] userErrors em "${node.title}" (${node.handle}):`, errs);
      } else {
        fixedCount += 1;
        console.log(`[fix-universe-desc] corrigido "${node.title}" (${node.handle})`);
      }
    }

    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  console.log(
    `[fix-universe-desc] DONE. scanned=${scanned} fixed=${fixedCount} skipped_no_copy=${skippedNoCopy} errors=${errorCount}${DRY_RUN ? " (dry run — nothing written)" : ""}`
  );
}

main().catch((err) => {
  console.error("[fix-universe-desc] fatal:", err);
  process.exit(1);
});
