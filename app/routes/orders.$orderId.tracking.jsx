/* eslint-env node */
import { authenticate } from "../shopify.server";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";

const ORDER_TRACKING_QUERY = `
  query OrderTracking($id: ID!) {
    order(id: $id) {
      name
      customer { id }
      fulfillments(first: 5) {
        displayStatus
        estimatedDeliveryAt
        trackingInfo { number url company }
      }
      lineItems(first: 50) {
        nodes { name quantity }
      }
    }
  }
`;

// Ordem de progressão de uma encomenda, na linguagem da marca. Ver dc-design
// "Alterpop Customer Account.dc.html" (secção Order tracking) — copy propositadamente
// lúdica em vez do texto genérico "unfulfilled/in transit/delivered". Qualquer estado de
// fulfillment não listado abaixo (inclui SUBMITTED/CONFIRMED/LABEL_PURCHASED/LABEL_PRINTED,
// e valores futuros que a Shopify venha a adicionar) cai no fallback "preparing".
const IN_TRANSIT = new Set([
  "FULFILLED",
  "MARKED_AS_FULFILLED",
  "CARRIER_PICKED_UP",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "ATTEMPTED_DELIVERY",
  "DELAYED",
  "READY_FOR_PICKUP",
]);
const DELIVERED = new Set(["DELIVERED", "PICKED_UP"]);
const NEEDS_ATTENTION = new Set(["CANCELED", "FAILURE", "NOT_DELIVERED", "LABEL_VOIDED"]);

function computeStage(fulfillments) {
  if (!fulfillments.length) return "preparing";
  if (fulfillments.some((f) => DELIVERED.has(f.displayStatus))) return "delivered";
  if (fulfillments.some((f) => NEEDS_ATTENTION.has(f.displayStatus))) return "attention";
  if (fulfillments.some((f) => IN_TRANSIT.has(f.displayStatus))) return "in_transit";
  // Anything else (PREPARING's statuses, or a future enum value Shopify adds) is "preparing".
  return "preparing";
}

function normalizeShopDomain(dest) {
  return String(dest || "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

/** GET /orders/:orderId/tracking — estado de preparo/envio de uma encomenda, em linguagem da marca. */
export const loader = async ({ request, params }) => {
  const { sessionToken, cors } = await authenticate.public.customerAccount(request);

  const shop = normalizeShopDomain(sessionToken.dest);
  const customerId = sessionToken.sub;
  if (!shop || !customerId) {
    return cors(Response.json({ error: "invalid_session" }, { status: 401 }));
  }

  const orderId = params.orderId;
  if (!/^\d+$/.test(String(orderId || ""))) {
    return cors(Response.json({ error: "invalid_order" }, { status: 400 }));
  }

  let offline;
  try {
    offline = await loadOfflineSessionForShop(shop);
  } catch (err) {
    console.error(`[orders.tracking] sem sessão offline para ${shop}: ${err.message}`);
    return cors(Response.json({ error: "shop_not_connected" }, { status: 503 }));
  }

  const client = createShopifyClientFromSession(offline);
  const data = await client.graphql(ORDER_TRACKING_QUERY, { id: `gid://shopify/Order/${orderId}` });
  const order = data?.order;

  if (!order || order.customer?.id !== customerId) {
    return cors(Response.json({ error: "not_found" }, { status: 404 }));
  }

  const fulfillments = order.fulfillments || [];
  const stage = computeStage(fulfillments);
  const tracking = fulfillments.find((f) => f.trackingInfo?.number) || null;
  const estimatedDeliveryAt = fulfillments.find((f) => f.estimatedDeliveryAt)?.estimatedDeliveryAt || null;

  return cors(
    Response.json({
      name: order.name,
      stage,
      tracking: tracking
        ? {
            number: tracking.trackingInfo.number,
            url: tracking.trackingInfo.url,
            company: tracking.trackingInfo.company,
          }
        : null,
      estimatedDeliveryAt,
      items: order.lineItems.nodes,
    })
  );
};
