import { redirect } from "react-router";
import { authenticateAdmin } from "../utils/authenticate.server";

/**
 * GET /api/shopify/grant-publications-scope
 * Redireciona o comerciante para aprovar read_publications/write_publications (scopes em falta na sessão).
 */
export const loader = async ({ request }) => {
  const { scopes } = await authenticateAdmin(request);
  await scopes.request(["read_publications", "write_publications"]);
  return redirect("/app");
};
