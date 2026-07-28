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

  const summary = await computeSyncStagingSummary(session.shop, skus);
  return Response.json({ ok: true, summary });
};
