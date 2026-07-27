import { authenticateAdmin } from "../utils/authenticate.server";
import {
  bulkSetMarginMultiplier,
  bulkSetQueueStatus,
} from "../../lib/curation/curationQueue.server.js";
import { invalidateCurationQueueCache } from "../../lib/importer/curation/index.js";

/**
 * POST /api/curation/queue/bulk
 * body: { skus: string[], action: 'approve'|'reject'|'margin', marginMultiplier?: number }
 */
export const action = async ({ request }) => {
  await authenticateAdmin(request);

  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }

  const skus = Array.isArray(body.skus) ? body.skus.map(String).filter(Boolean) : [];
  if (!skus.length) {
    return Response.json({ ok: false, error: "Lista de SKUs vazia." }, { status: 400 });
  }

  const actionName = String(body.action || "");
  try {
    if (actionName === "approve" || actionName === "reject") {
      const targetStatus = actionName === "approve" ? "APPROVED" : "REJECTED";
      const result = await bulkSetQueueStatus(skus, targetStatus);
      invalidateCurationQueueCache();
      return Response.json({
        ok: true,
        action: actionName,
        updated: result.updatedItems.length,
        previousSnapshots: result.previousSnapshots,
      });
    }

    if (actionName === "margin") {
      const multiplier = Number(body.marginMultiplier);
      const result = await bulkSetMarginMultiplier(skus, multiplier);
      invalidateCurationQueueCache();
      return Response.json({
        ok: true,
        action: actionName,
        updated: result.updatedItems.length,
        marginMultiplier: result.marginMultiplier,
      });
    }

    return Response.json({ ok: false, error: "Ação inválida." }, { status: 400 });
  } catch (err) {
    return Response.json({ ok: false, error: err?.message || String(err) }, { status: 500 });
  }
};

