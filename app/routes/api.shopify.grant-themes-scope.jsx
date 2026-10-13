import { authenticateAdmin } from "../utils/authenticate.server";
import { requestScopesOutOfFrame } from "../utils/requestScopes.server";

/**
 * GET /api/shopify/grant-themes-scope
 * Leva o comerciante a aprovar read_themes (guarda do tema, Decisão 32), fora do iframe do
 * Admin. Só leitura: a app nunca pede write_themes.
 */
export const loader = async ({ request }) => {
  const { scopes, redirect } = await authenticateAdmin(request);
  return requestScopesOutOfFrame({ scopes, redirect, requested: ["read_themes"] });
};
