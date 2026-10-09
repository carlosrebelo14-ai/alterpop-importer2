import { authenticateAdmin } from "../utils/authenticate.server";
import { bulkSetMarginPct, bulkSetQueueStatus } from "../../lib/curation/curationQueue.server.js";
import { assertMarginPct } from "../../lib/importer/pricing/pricing.server.js";
import { invalidateCurationQueueCache } from "../../lib/importer/curation/index.js";
import { resolveFilteredSkus } from "../../lib/curation/resolveFilteredSkus.server.js";
import { assertBulkConfirm, BulkConfirmError, BULK_SAMPLE_SIZE } from "../../lib/curation/bulkConfirm.js";

/**
 * POST /api/curation/queue/bulk
 * body: { skus: string[], action: 'approve'|'reject'|'margin', marginPct?: number|null }
 * (margin: margem por produto em %, 5–100; null volta à margem global)
 * ou body: { action: 'approve_filtered'|'reject_filtered', filters: {...} }
 * Acima de 50 produtos, approve/reject (e as variantes _filtered) exigem confirmCount igual ao
 * número real (D1): sem ele, ou diferente, o servidor recusa e não grava nada.
 * body: { action: 'preview_filtered', filters } → { count, sample: [{ sku, title }] } (5 SKUs)
 */
export const action = async ({ request }) => {
  const { session } = await authenticateAdmin(request);

  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }

  const actionName = String(body.action || "");
  try {
    let skus = Array.isArray(body.skus) ? body.skus.map(String).filter(Boolean) : [];

    if (actionName === "approve_filtered" || actionName === "reject_filtered") {
      skus = await resolveFilteredSkus(session.shop, body.filters || {});
    }

    if (!skus.length && actionName !== "preview_filtered") {
      return Response.json({ ok: false, error: "Nenhum produto encontrado para esta ação." }, { status: 400 });
    }

    // Pré-visualização do âmbito de uma ação sobre o filtro atual: contagem e amostra de 5.
    if (actionName === "preview_filtered") {
      const matching = await resolveFilteredSkus(session.shop, body.filters || {});
      const { loadCurationQueueCached } = await import("../../lib/curation/curationQueue.server.js");
      const byTitle = new Map((await loadCurationQueueCached()).items.map((i) => [i.sku, i.title_en]));
      return Response.json({
        ok: true,
        count: matching.length,
        sample: matching.slice(0, BULK_SAMPLE_SIZE).map((sku) => ({ sku, title: byTitle.get(sku) || null })),
      });
    }

    if (["approve", "reject", "approve_filtered", "reject_filtered"].includes(actionName)) {
      assertBulkConfirm(skus.length, body.confirmCount, {
        what: actionName.startsWith("approve") ? "Aprovar" : "Rejeitar",
      });
    }

    if (actionName === "approve" || actionName === "reject" || actionName === "approve_filtered" || actionName === "reject_filtered") {
      const targetStatus = actionName.startsWith("approve") ? "APPROVED" : "REJECTED";
      const result = await bulkSetQueueStatus(skus, targetStatus);
      invalidateCurationQueueCache();
      return Response.json({
        ok: true,
        action: actionName,
        updated: result.updatedItems.length,
        previousSnapshots: result.previousSnapshots,
        // O frontend precisa disto para actualizar o estado local `decisions` depois de
        // approve_filtered/reject_filtered — sem a lista de SKUs de volta, o botão
        // "Publicar na Shopify" ficava cinzento até um reload completo da página (o
        // segundo bug do mesmo report: approve_filtered nunca actualizava `decisions`).
        skus,
      });
    }

    if (actionName === "margin") {
      // null/"" = repor a margem global. Fora de 5–100 % ou com mais de 2 casas → 400,
      // nada gravado (assertMarginPct, a mesma validação da margem global).
      const raw = body.marginPct;
      let marginPct = null;
      if (raw != null && raw !== "") {
        try {
          marginPct = assertMarginPct(raw);
        } catch (err) {
          return Response.json({ ok: false, error: err?.message || String(err) }, { status: 400 });
        }
      }
      const result = await bulkSetMarginPct(skus, marginPct);
      invalidateCurationQueueCache();
      return Response.json({
        ok: true,
        action: actionName,
        updated: result.updatedItems.length,
        missing: result.missing,
        marginPct,
      });
    }

    return Response.json({ ok: false, error: "Ação inválida." }, { status: 400 });
  } catch (err) {
    if (err instanceof BulkConfirmError) {
      return Response.json(
        { ok: false, code: err.code, error: err.message, count: err.count, confirmed: err.confirmed },
        { status: 409 }
      );
    }
    return Response.json({ ok: false, error: err?.message || String(err) }, { status: 500 });
  }
};
