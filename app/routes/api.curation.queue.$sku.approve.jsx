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
    return Response.json(
      { ok: false, error: err?.message || String(err) },
      { status: 404 }
    );
  }
};
