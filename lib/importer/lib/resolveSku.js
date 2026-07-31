const PRODUCT_BY_SKU = `
  query ProductBySku($query: String!) {
    products(first: 1, query: $query) {
      nodes {
        id
        title
        variants(first: 20) {
          nodes {
            id
            sku
            inventoryItem {
              id
            }
          }
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

  const cleanSku = String(sku || "").trim();
  if (!cleanSku) return null;

  const safeSku = cleanSku.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  try {
    const data = await client.graphql(PRODUCT_BY_SKU, { query: `sku:"${safeSku}"` });
    const productNode = data.products?.nodes?.[0];
    if (productNode) {
      const matchedVariant =
        productNode.variants?.nodes?.find(
          (v) => (v.sku || "").trim().toLowerCase() === cleanSku.toLowerCase()
        ) || productNode.variants?.nodes?.[0] || null;

      if (matchedVariant) {
        const result = {
          id: matchedVariant.id,
          sku: matchedVariant.sku,
          product: { id: productNode.id, title: productNode.title },
          inventoryItem: matchedVariant.inventoryItem || null,
        };
        cache.set(sku, result);
        return result;
      }
    }
  } catch (err) {
    console.warn(`[resolveSku] Warning checking SKU ${sku}:`, err?.message || err);
  }

  cache.set(sku, null);
  return null;
}
