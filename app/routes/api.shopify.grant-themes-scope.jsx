import { redirect } from "react-router";
import { authenticateAdmin } from "../utils/authenticate.server";

/**
 * GET /api/shopify/grant-themes-scope
 * Redireciona o comerciante para aprovar read_themes (guarda do tema, Decisão 32). Só leitura:
 * a app nunca pede write_themes.
 */
export const loader = async ({ request }) => {
  const { scopes } = await authenticateAdmin(request);
  await scopes.request(["read_themes"]);
  return redirect("/app");
};
