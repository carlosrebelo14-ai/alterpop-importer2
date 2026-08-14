/* eslint-env node */
import { authenticate } from "../shopify.server";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";

const MAX_WISHLIST_SIZE = 100;

const WISHLIST_IDS_QUERY = `
  query CustomerWishlistIds($id: ID!) {
    customer(id: $id) {
      metafield(namespace: "custom", key: "wishlist") { value }
    }
  }
`;

const WISHLIST_RESOLVED_QUERY = `
  query CustomerWishlist($id: ID!) {
    customer(id: $id) {
      metafield(namespace: "custom", key: "wishlist") {
        references(first: ${MAX_WISHLIST_SIZE}) {
          nodes {
            ... on Product {
              id
              title
              handle
              featuredImage { url }
              priceRangeV2 { minVariantPrice { amount currencyCode } }
            }
          }
        }
      }
    }
  }
`;

const SET_WISHLIST_MUTATION = `
  mutation SetWishlist($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message code }
    }
  }
`;

function normalizeShopDomain(dest) {
  return String(dest || "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

function parseIds(rawValue) {
  try {
    const parsed = JSON.parse(rawValue || "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

async function fetchResolvedWishlist(client, customerId) {
  const data = await client.graphql(WISHLIST_RESOLVED_QUERY, { id: customerId });
  return data?.customer?.metafield?.references?.nodes || [];
}

/** Autentica um pedido de extensão de Customer Account e devolve {shop, customerId} ou uma Response de erro pronta a devolver. */
async function requireCustomerSession(request) {
  const { sessionToken, cors } = await authenticate.public.customerAccount(request);
  const shop = normalizeShopDomain(sessionToken.dest);
  const customerId = sessionToken.sub;
  if (!shop || !customerId) {
    return { error: cors(Response.json({ error: "invalid_session" }, { status: 401 })) };
  }
  return { shop, customerId, cors };
}

async function connectShopifyClient(shop, cors) {
  try {
    const offline = await loadOfflineSessionForShop(shop);
    return { client: createShopifyClientFromSession(offline) };
  } catch (err) {
    console.error(`[wishlist] sem sessão offline para ${shop}: ${err.message}`);
    return { error: cors(Response.json({ error: "shop_not_connected" }, { status: 503 })) };
  }
}

/** GET /wishlist — lista os produtos guardados pelo cliente autenticado. */
export const loader = async ({ request }) => {
  const auth = await requireCustomerSession(request);
  if (auth.error) return auth.error;
  const { shop, customerId, cors } = auth;

  const conn = await connectShopifyClient(shop, cors);
  if (conn.error) return conn.error;

  const products = await fetchResolvedWishlist(conn.client, customerId);
  return cors(Response.json({ products }));
};

/** POST /wishlist { action: "add"|"remove", productId } — atualiza o metafield custom.wishlist do cliente. */
export const action = async ({ request }) => {
  const auth = await requireCustomerSession(request);
  if (auth.error) return auth.error;
  const { shop, customerId, cors } = auth;

  let body;
  try {
    body = await request.json();
  } catch {
    return cors(Response.json({ error: "invalid_body" }, { status: 400 }));
  }

  const isValidAction = body?.action === "add" || body?.action === "remove";
  const isValidProductId = /^gid:\/\/shopify\/Product\/\d+$/.test(String(body?.productId || ""));
  if (!isValidAction || !isValidProductId) {
    return cors(Response.json({ error: "invalid_input" }, { status: 400 }));
  }

  const conn = await connectShopifyClient(shop, cors);
  if (conn.error) return conn.error;
  const { client } = conn;

  const current = await client.graphql(WISHLIST_IDS_QUERY, { id: customerId });
  const currentIds = parseIds(current?.customer?.metafield?.value);

  const nextIds =
    body.action === "add"
      ? Array.from(new Set([...currentIds, body.productId])).slice(0, MAX_WISHLIST_SIZE)
      : currentIds.filter((id) => id !== body.productId);

  const setResult = await client.graphql(SET_WISHLIST_MUTATION, {
    metafields: [
      {
        ownerId: customerId,
        namespace: "custom",
        key: "wishlist",
        type: "list.product_reference",
        value: JSON.stringify(nextIds),
      },
    ],
  });

  if (setResult?.metafieldsSet?.userErrors?.length) {
    console.error(`[wishlist] falha ao gravar: ${JSON.stringify(setResult.metafieldsSet.userErrors)}`);
    return cors(Response.json({ error: "write_failed" }, { status: 500 }));
  }

  const products = await fetchResolvedWishlist(client, customerId);
  return cors(Response.json({ products }));
};
