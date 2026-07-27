import { redirect } from "react-router";
import { authenticateAdmin } from "../utils/authenticate.server";

/**
 * GET /api/shopify/grant-orders-scope
 * Redireciona o comerciante para aprovar read_orders (scope em falta na sessão).
 */
export const loader = async ({ request }) => {
  const { scopes } = await authenticateAdmin(request);
  await scopes.request(["read_orders"]);
  return redirect("/app");
};
