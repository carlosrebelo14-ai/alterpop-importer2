const VARIANT_BY_SKU = `
  query VariantBySku($query: String!) {
    productVariants(first: 1, query: $query) {
      nodes {
        id
        sku
        product {
          id
          title
        }
        inventoryItem {
          id
        }
      }
    }
  }
`;

/**
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} sku
 * @param {Map<string, object>} cache
 */
export async function resolveVariantBySku(client, sku, cache) {
  if (cache.has(sku)) return cache.get(sku);

  const safeSku = String(sku || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const data = await client.graphql(VARIANT_BY_SKU, { query: `sku:"${safeSku}"` });
  const variant = data.productVariants?.nodes?.[0] || null;
  cache.set(sku, variant);
  return variant;
}
