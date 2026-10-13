import { authenticateAdmin } from "../utils/authenticate.server";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { refreshThemeContract } from "../../lib/importer/shopify/themeContract.server.js";
import { isThemeGuardEnforced } from "../../lib/importer/shopify/themeContract.js";

/**
 * POST /api/theme-contract/refresh — relê o tema publicado (ignora o snapshot) e reavalia o
 * contrato. Só leitura: nada é escrito no tema. Mesma resposta que o GET de status.
 */
export const action = async ({ request }) => {
  const { session } = await authenticateAdmin(request);
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }
  try {
    const client = createShopifyClientFromSession(await loadOfflineSessionForShop(session.shop));
    const contract = await refreshThemeContract(client, session.shop, { includeFranchise: true });
    return Response.json({ ok: true, enforced: isThemeGuardEnforced(), contract });
  } catch (err) {
    return Response.json({ ok: false, error: err?.message || String(err) }, { status: 502 });
  }
};
