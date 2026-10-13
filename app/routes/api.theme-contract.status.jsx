import { authenticateAdmin } from "../utils/authenticate.server";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { getThemeContractStatus, readStoredThemeStatus } from "../../lib/importer/shopify/themeContract.server.js";
import { isThemeGuardEnforced } from "../../lib/importer/shopify/themeContract.js";

/**
 * GET /api/theme-contract/status — contrato do tema publicado (Decisão 32): estado, bloqueios
 * (templates/definições/guarda de franquias) e avisos. Só leitura. Reaproveita o snapshot
 * enquanto o `updatedAt` do tema MAIN não muda.
 * ?stored=1 devolve só o último estado guardado, sem ir à loja.
 * Resposta: { ok, enforced, contract: { status, blocking, warnings, themeName, themeUpdatedAt, checkedAt, rebuilt } }
 */
export const loader = async ({ request }) => {
  const { session } = await authenticateAdmin(request);
  const enforced = isThemeGuardEnforced();
  if (new URL(request.url).searchParams.get("stored") === "1") {
    return Response.json({ ok: true, enforced, contract: await readStoredThemeStatus(session.shop) });
  }
  try {
    const client = createShopifyClientFromSession(await loadOfflineSessionForShop(session.shop));
    const contract = await getThemeContractStatus(client, session.shop, { includeFranchise: true });
    return Response.json({ ok: true, enforced, contract });
  } catch (err) {
    return Response.json({ ok: false, enforced, error: err?.message || String(err) }, { status: 502 });
  }
};
