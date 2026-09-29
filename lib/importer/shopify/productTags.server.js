/**
 * Leitura e remoção de tags de produto — N4, opção A (29/09/2026).
 * Leitura: portão V18 (TAG_OUTSIDE_ALLOWLIST) e tags-cleanup.js.
 * Escrita: só tagsRemove, e só pelo tags-cleanup.js (exceção explícita à regra de
 * escrita, decidida pelo Carlos para a opção A). Nunca productUpdate.
 */

const PRODUCT_TAGS_READ = `
  query ProductTagsRead($query: String!, $cursor: String) {
    products(first: 250, after: $cursor, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        status
        tags
        variants(first: 1) { nodes { sku } }
        syncLocked: metafield(namespace: "ociostock", key: "sync_locked") { value }
      }
    }
  }
`;

const PRODUCT_TAGS_REMOVE = `
  mutation ProductTagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

/**
 * Todos os produtos da query (paginado), no formato de tagAllowlist.js.
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} [query] pesquisa Shopify, por omissão "status:active"
 */
export async function fetchProductTags(client, query = "status:active") {
  const out = [];
  let cursor = null;
  for (;;) {
    const data = await client.graphql(PRODUCT_TAGS_READ, { query, cursor });
    const conn = data?.products;
    for (const n of conn?.nodes || []) {
      out.push({
        productId: n.id,
        handle: n.handle,
        status: n.status,
        sku: n.variants?.nodes?.[0]?.sku || null,
        tags: n.tags || [],
        syncLocked: n.syncLocked?.value === "true",
      });
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}

/**
 * tagsRemove de uma lista de tags num produto. Lança em userErrors — nada em silêncio.
 * @param {import('../shopifyClient.js').ShopifyClient} client
 */
export async function removeProductTags(client, productId, tags) {
  const data = await client.graphql(PRODUCT_TAGS_REMOVE, { id: productId, tags });
  const errors = data.tagsRemove?.userErrors || [];
  if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
}
