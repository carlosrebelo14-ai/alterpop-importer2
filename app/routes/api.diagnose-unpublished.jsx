import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import {
  loadOfflineSessionForShop,
  isShopifyAuthError,
} from "../../lib/session/loadOfflineSessionForShop.server.js";

const QUERY_UNPUBLISHED = `
  query {
    products(first: 100, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id
        title
        handle
        status
        updatedAt
        resourcePublicationsV2(first: 1) {
          nodes {
            publication {
              name
              id
            }
            isPublished
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export async function loader() {
  const shop = "jyr17t-wr.myshopify.com";

  try {
    const session = await loadOfflineSessionForShop(shop);
    const client = createShopifyClientFromSession(session);

    const result = await client.graphql(QUERY_UNPUBLISHED);

    if (!result.products) {
      return Response.json({ error: "Invalid GraphQL response", details: result });
    }

    const allProducts = result.products.nodes;
    const unpublished = allProducts.filter((p) => {
      const pubNode = p.resourcePublicationsV2?.nodes?.[0];
      return !pubNode || !pubNode.isPublished;
    });

    const preview = unpublished.slice(0, 10).map((p) => ({
      title: p.title,
      id: p.id,
      handle: p.handle,
      status: p.status,
      updatedAt: p.updatedAt,
      isPublished: p.resourcePublicationsV2?.nodes?.[0]?.isPublished || false,
    }));

    return Response.json({
      ok: true,
      total: allProducts.length,
      published: allProducts.length - unpublished.length,
      unpublished: unpublished.length,
      preview,
      hasMore: unpublished.length > 10,
      message:
        unpublished.length === 0
          ? "✅ Nenhum produto não publicado encontrado"
          : `⚠️ ${unpublished.length} produto(s) não publicado(s)`,
    });
  } catch (err) {
    if (isShopifyAuthError(err)) {
      return Response.json(
        { error: "Shopify auth error", message: err.message },
        { status: 401 }
      );
    }
    return Response.json(
      { error: "Failed to query Shopify", message: err.message },
      { status: 500 }
    );
  }
}
