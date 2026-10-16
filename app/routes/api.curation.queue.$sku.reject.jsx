import { authenticateAdmin } from "../utils/authenticate.server";
import { rejectProduct } from "../../lib/curation/curationQueue.server.js";
import { invalidateCurationQueueCache } from "../../lib/importer/curation/index.js";

/**
 * POST /api/curation/queue/:sku/reject
 * Rejeita produto — próxima sync mantém DRAFT.
 */
export const action = async ({ request, params }) => {
  await authenticateAdmin(request);

  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  const sku = params.sku;
  if (!sku) {
    return Response.json({ ok: false, error: "SKU required" }, { status: 400 });
  }

  try {
    const { item, previousSnapshot } = await rejectProduct(sku);
    invalidateCurationQueueCache();
    return Response.json({
      ok: true,
      message: "Product rejected for next sync",
      item,
      previousSnapshot,
    });
  } catch (err) {
    // Prazo do lock da fila esgotado: nada foi escrito. Pede-se nova tentativa, não um erro.
    if (err?.code === "CURATION_QUEUE_LOCK_TIMEOUT") {
      return Response.json({ ok: false, error: "fila ocupada, tenta de novo" }, { status: 503 });
    }
    return Response.json(
      { ok: false, error: err?.message || String(err) },
      { status: 404 }
    );
  }
};
