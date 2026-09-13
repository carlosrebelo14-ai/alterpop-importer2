import { authenticateAdmin } from "../utils/authenticate.server";
import { computeSyncStagingSummary } from "../../lib/importer/sync/syncStagingSummary.server.js";

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
  return Response.json({ ok: true, summary });
};
