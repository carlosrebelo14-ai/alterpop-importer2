#!/usr/bin/env node
/**
 * Só leitura — dois factos precisos para fechar a decisão de arredondamento/margem
 * (rácio 1,19 entre painel e loja, 24/09):
 *   1. shop.taxesIncluded — os preços na loja já incluem IVA ou é somado no checkout?
 *   2. Preço live dos dois SKUs do incidente, direto da Admin API (não do SQLite
 *      local, para confirmar contra a fonte real que o cliente vê).
 *
 * Não escreve nada.
 *
 * Corre na Fly (é lá que está a sessão OAuth offline):
 *   flyctl ssh console -a alterpop-importer-app \
 *     -C "node scripts/catalog/shop-price-facts-check.js"
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";

const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
const SKUS = ["4573102723772", "4573102669964"];

const QUERY = `
  query ShopPriceFacts($query: String!) {
    shop {
      taxesIncluded
      currencyCode
    }
    productVariants(first: 5, query: $query) {
      nodes {
        sku
        price
        product { title }
      }
    }
  }
`;

async function main() {
  console.log(`=== shop-price-facts-check (${SHOP}) · só leitura ===`);

  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  const data = await client.graphql(QUERY, { query: SKUS.map((s) => `sku:${s}`).join(" OR ") });

  console.log(`\nshop.taxesIncluded: ${data.shop.taxesIncluded}`);
  console.log(`shop.currencyCode: ${data.shop.currencyCode}`);

  console.log(`\nPreços live (Admin API):`);
  for (const v of data.productVariants.nodes) {
    console.log(`  ${v.sku} — ${v.price} — ${v.product.title}`);
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
