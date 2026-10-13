import { authenticateAdmin } from "../utils/authenticate.server";
import { bulkSetMarginPct, bulkTransitionPending, loadCurationQueue } from "../../lib/curation/curationQueue.server.js";
import { partitionBulkEligible } from "../../lib/curation/bulkEligibility.js";
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
 * body: { action: 'preview_filtered', filters } → { count, eligible, toCreate, skippedCount, sample: [{ sku, title }] } (5 SKUs)
 *
 * Aprovar/rejeitar em massa SÓ tocam produtos PENDING (Decisão 31): PUBLISHED, REJECTED,
 * SYNC_ERROR e APPROVED ficam como estão e vêm em `skipped`. SKU sem entrada na fila conta
 * como PENDING: a ação cria a entrada como PENDING e aplica a transição (idempotente), e
 * `createdCount` diz à parte quantas foram criadas. O número a confirmar (confirmCount) é o
 * dos elegíveis, não o dos pedidos. Resposta: { updated, skus (só os alterados), created,
 * createdCount, skipped, skippedCount, skippedByStatus, requested, previousSnapshots }.
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
      const queue = await loadCurationQueue();
      const { eligible, toCreate, skipped } = partitionBulkEligible(queue.items, matching);
      const byTitle = new Map(queue.items.map((i) => [i.sku, i.title_en]));
      return Response.json({
        ok: true,
        count: matching.length,
        // O que a ação vai mesmo tocar: só PENDING (e os sem entrada, que contam como PENDING).
        eligible: eligible.length,
        toCreate: toCreate.length,
        skippedCount: skipped.length,
        sample: eligible.slice(0, BULK_SAMPLE_SIZE).map((sku) => ({ sku, title: byTitle.get(sku) || null })),
      });
    }

    if (actionName === "approve" || actionName === "reject" || actionName === "approve_filtered" || actionName === "reject_filtered") {
      const targetStatus = actionName.startsWith("approve") ? "APPROVED" : "REJECTED";
      // Só PENDING (e sem entrada): o número a confirmar é o dos elegíveis, calculado ANTES de
      // gravar nada — nunca o dos pedidos, que incluiria publicados, rejeitados e com erro.
      const { eligible, skipped } = partitionBulkEligible((await loadCurationQueue()).items, skus);
      const skippedByStatus = {};
      for (const k of skipped) skippedByStatus[k.status] = (skippedByStatus[k.status] || 0) + 1;
      const summary = { requested: skus.length, skippedCount: skipped.length, skippedByStatus, skipped: skipped.slice(0, 50) };
      if (!eligible.length) {
        return Response.json({ ok: true, action: actionName, updated: 0, skus: [], created: [], createdCount: 0, previousSnapshots: [], ...summary });
      }
      assertBulkConfirm(eligible.length, body.confirmCount, {
        what: actionName.startsWith("approve") ? "Aprovar" : "Rejeitar",
      });
      const result = await bulkTransitionPending(eligible, targetStatus);
      invalidateCurationQueueCache();
      return Response.json({
        ok: true,
        action: actionName,
        updated: result.updatedItems.length,
        previousSnapshots: result.previousSnapshots,
        // O frontend precisa disto para actualizar o estado local `decisions` depois de
        // aprovar/rejeitar — só os SKUs realmente alterados (os ignorados mantêm o estado).
        skus: result.skus,
        created: result.created,
        createdCount: result.createdCount,
        ...summary,
        // Ignorados entre a leitura e a gravação (outra pessoa decidiu entretanto).
        skippedCount: skipped.length + result.skipped.length,
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
