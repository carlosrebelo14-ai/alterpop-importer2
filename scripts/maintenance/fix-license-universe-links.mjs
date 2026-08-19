// Ferramenta de manutenção pontual — corrige a tabela "License / Universe" já
// gravada em product.descriptionHtml de produtos publicados antes da correção
// de buildProductDescriptionHtml (lib/importer/shopify/shopifyMapper.server.js):
// os links apontavam para /collections/<slug-da-categoria-em-bruto>, que quase
// nunca existe (ver sessão de debug de 2026-08-19). Corrige só esses links,
// para /collections/all?filter.p.tag=..., sem tocar em mais nada da descrição.
//
// Uso: node scripts/maintenance/fix-license-universe-links.mjs [--dry-run]
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";

const DRY_RUN = process.argv.includes("--dry-run");
const SHOP = process.env.SHOPIFY_SHOP_URL;

const BAD_LINK_RE =
  /<a href="\/collections\/(?!all)([^"?]+)" style="color:#005bd3;text-decoration:underline;font-weight:500;">([^<]+)<\/a>/g;

function fixDescription(html) {
  let changed = false;
  const fixed = html.replace(BAD_LINK_RE, (_match, _slug, label) => {
    changed = true;
    const url = `/collections/all?filter.p.tag=${encodeURIComponent(label)}`;
    return `<a href="${url}" style="color:#005bd3;text-decoration:underline;font-weight:500;">${label}</a>`;
  });
  return { fixed, changed };
}

const PRODUCTS_PAGE = `
  query FixLinksPage($cursor: String) {
    products(first: 100, after: $cursor, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      nodes { id descriptionHtml }
    }
  }
`;

const PRODUCT_UPDATE = `
  mutation FixLinksUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id }
      userErrors { field message }
    }
  }
`;

async function main() {
  if (!SHOP) throw new Error("SHOPIFY_SHOP_URL not set");
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  let cursor = null;
  let scanned = 0;
  let fixedCount = 0;
  let errorCount = 0;
  const startedAt = Date.now();

  for (;;) {
    const data = await client.graphql(PRODUCTS_PAGE, { cursor });
    const page = data.products;

    for (const node of page.nodes) {
      scanned += 1;
      const { fixed, changed } = fixDescription(node.descriptionHtml || "");
      if (!changed) continue;

      if (DRY_RUN) {
        fixedCount += 1;
        continue;
      }

      try {
        const res = await client.graphql(PRODUCT_UPDATE, {
          input: { id: node.id, descriptionHtml: fixed },
        });
        const errs = res.productUpdate?.userErrors || [];
        if (errs.length) {
          errorCount += 1;
          console.error(`[fix-license-links] userErrors on ${node.id}:`, errs);
        } else {
          fixedCount += 1;
        }
      } catch (err) {
        errorCount += 1;
        console.error(`[fix-license-links] failed on ${node.id}:`, err?.message || err);
      }
    }

    console.log(
      `[fix-license-links] scanned=${scanned} fixed=${fixedCount} errors=${errorCount} elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`
    );

    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  console.log(
    `[fix-license-links] DONE. scanned=${scanned} fixed=${fixedCount} errors=${errorCount}${DRY_RUN ? " (dry run — nothing written)" : ""}`
  );
}

main().catch((err) => {
  console.error("[fix-license-links] fatal:", err);
  process.exit(1);
});
