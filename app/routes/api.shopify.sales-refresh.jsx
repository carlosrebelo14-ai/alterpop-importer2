import { AuthScopes } from "@shopify/shopify-api";
import { authenticateAdmin } from "../utils/authenticate.server";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { refreshProductSalesSnapshot } from "../../lib/importer/shopify/salesRadar.server.js";

function sessionHasReadOrders(session) {
  if (!session?.scope) return false;
  return new AuthScopes(session.scope).has("read_orders");
}

/**
 * POST /api/shopify/sales-refresh — actualiza vendas 30 dias (Radar de Curadoria).
 */
export const action = async ({ request }) => {
  const { session } = await authenticateAdmin(request);

  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  if (!sessionHasReadOrders(session)) {
    const url = new URL(request.url);
    const grantUrl = `/api/shopify/grant-orders-scope?${url.searchParams.toString()}`;
    return Response.json(
      {
        ok: false,
        needsScopeGrant: true,
        grantUrl,
        error:
          "A app precisa de permissão para ler encomendas (read_orders). Clica OK para autorizar na Shopify.",
      },
      { status: 403 }
    );
  }

  try {
    const client = createShopifyClientFromSession(session);
    const result = await refreshProductSalesSnapshot(session.shop, client);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    const message = err?.message || String(err);
    const needsScope = /access|scope|denied|403|read_orders/i.test(message);
    const url = new URL(request.url);
    return Response.json(
      {
        ok: false,
        needsScopeGrant: needsScope,
        grantUrl: needsScope
          ? `/api/shopify/grant-orders-scope?${url.searchParams.toString()}`
          : undefined,
        error: needsScope
          ? "Permissão read_orders em falta — autoriza na Shopify."
          : message,
      },
      { status: needsScope ? 403 : 500 }
    );
  }
};
