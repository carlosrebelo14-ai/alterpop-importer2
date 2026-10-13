import { authenticateAdmin } from "../utils/authenticate.server";
import { computeSyncStagingSummary } from "../../lib/importer/sync/syncStagingSummary.server.js";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { getThemeContractStatus, readStoredThemeStatus } from "../../lib/importer/shopify/themeContract.server.js";
import { isThemeGuardEnforced } from "../../lib/importer/shopify/themeContract.js";

/**
 * GET /api/curation/sync-preview?skus=SKU1,SKU2
 */
export const loader = async ({ request }) => {
  const { session } = await authenticateAdmin(request);
  const url = new URL(request.url);
  const skusRaw = url.searchParams.get("skus") || "";
  const skus = skusRaw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

  // Briefing "Leitura confirmada" (Decisão 30) — computeSyncStagingSummary lança em
  // vez de degradar silenciosamente. Nunca devolver ok:true com um resumo vazio/
  // parcial quando a leitura falhou — o frontend (app._index.jsx) já sabe distinguir
  // ok:false + error (toast com a mensagem) de uma exceção de fetch, sem precisar de
  // alteração nenhuma aqui.
  let summary;
  try {
    summary = await computeSyncStagingSummary(session.shop, skus);
  } catch (err) {
    console.error("[sync-preview] leitura falhou, resumo indisponível:", err?.message || err);
    return Response.json(
      { ok: false, error: `Resumo indisponível — leitura falhou (${err?.message || err})` },
      { status: 502 }
    );
  }

  // Guarda do tema (Decisão 32): avisos aparecem no staging, sem bloquear a aprovação nem a
  // abertura do modal. Leitura ao vivo (reaproveita o snapshot enquanto o tema não muda); se
  // falhar, o último estado guardado e o motivo — nunca um «tudo ok» inventado.
  let themeContract;
  try {
    const client = createShopifyClientFromSession(await loadOfflineSessionForShop(session.shop));
    themeContract = await getThemeContractStatus(client, session.shop, { includeFranchise: false });
  } catch (err) {
    themeContract = { ...(await readStoredThemeStatus(session.shop)), readError: err?.message || String(err) };
  }
  return Response.json({
    ok: true,
    summary: {
      ...summary,
      themeContract: {
        status: themeContract.status,
        warnings: themeContract.warnings || [],
        blocking: themeContract.blocking || [],
        enforced: isThemeGuardEnforced(),
        readError: themeContract.readError ?? null,
      },
    },
  });
};
