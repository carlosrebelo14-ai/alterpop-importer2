const PRODUCT_BY_SKU = `
  query ProductBySku($query: String!) {
    products(first: 1, query: $query) {
      nodes {
        id
        title
        syncLockedMetafield: metafield(namespace: "ociostock", key: "sync_locked") {
          value
        }
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
          // syncLocked vem já nesta mesma query (metafield ociostock.sync_locked) em
          // vez de precisar de uma chamada GraphQL extra por produto — antes,
          // isProductSyncLocked() fazia essa segunda chamada sempre que um produto já
          // existente era actualizado (achado de eficiência no code review, 2026-08-12).
          product: {
            id: productNode.id,
            title: productNode.title,
            syncLocked: productNode.syncLockedMetafield?.value === "true",
          },
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
