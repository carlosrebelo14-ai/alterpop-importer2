import { authenticateAdmin } from "../utils/authenticate.server";
import { restoreQueueSnapshots } from "../../lib/curation/curationQueue.server.js";
import { invalidateCurationQueueCache } from "../../lib/importer/curation/index.js";

/**
 * POST /api/curation/queue/undo
 * body: { snapshots: Array<{sku,status,shopifyStatus,metadata}> }
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

  const snapshots = Array.isArray(body.snapshots) ? body.snapshots : [];
  if (!snapshots.length) {
    return Response.json({ ok: false, error: "Sem snapshots para desfazer." }, { status: 400 });
  }

  try {
    const result = await restoreQueueSnapshots(snapshots);
    invalidateCurationQueueCache();
    // Decisão 3: os ignorados (já publicados na Shopify) vêm na resposta, com a contagem e os SKU.
    return Response.json({
      ok: true,
      restored: result.restored.length,
      skippedCount: result.skippedCount,
      skipped: result.skipped.slice(0, 50),
    });
  } catch (err) {
    return Response.json({ ok: false, error: err?.message || String(err) }, { status: 500 });
  }
};

