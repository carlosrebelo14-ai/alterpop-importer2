import { authenticateAdmin } from "../utils/authenticate.server";
import {
  approveProduct,
} from "../../lib/curation/curationQueue.server.js";
import { invalidateCurationQueueCache } from "../../lib/importer/curation/index.js";

/**
 * POST /api/curation/queue/:sku/approve
 * Aprova produto — próxima sync usa shopifyStatus ACTIVE.
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
    const { item, previousSnapshot } = await approveProduct(sku);
    invalidateCurationQueueCache();
    return Response.json({
      ok: true,
      message: "Product approved for next sync",
      item,
      previousSnapshot,
    });
  } catch (err) {
    if (err?.code === "APPROVE_PUBLISHED") {
      return Response.json({ ok: false, error: err.message }, { status: 409 });
    }
    // Modo degradado (Decisão 34): 503 com a causa, não 404 de "SKU não encontrado".
    if (err?.code === "DB_DEGRADED") {
      return Response.json({ ok: false, error: err.message, dbDegraded: err.state ?? null }, { status: 503 });
    }
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
