/* eslint-env node */
import { authenticate } from "../shopify.server";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";

const CUSTOMER_QUERY = `
  query CustomerMe($id: ID!) {
    customer(id: $id) { firstName }
  }
`;

function normalizeShopDomain(dest) {
  return String(dest || "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

/** GET /customer/me — nome próprio do cliente autenticado, para saudação personalizada. */
export const loader = async ({ request }) => {
  const { sessionToken, cors } = await authenticate.public.customerAccount(request);
  const shop = normalizeShopDomain(sessionToken.dest);
  const customerId = sessionToken.sub;
  if (!shop || !customerId) {
    return cors(Response.json({ error: "invalid_session" }, { status: 401 }));
  }

  let offline;
  try {
    offline = await loadOfflineSessionForShop(shop);
  } catch (err) {
    console.error(`[customer.me] sem sessão offline para ${shop}: ${err.message}`);
    return cors(Response.json({ error: "shop_not_connected" }, { status: 503 }));
  }

  const client = createShopifyClientFromSession(offline);
  const data = await client.graphql(CUSTOMER_QUERY, { id: customerId });
  return cors(Response.json({ firstName: data?.customer?.firstName || null }));
};
