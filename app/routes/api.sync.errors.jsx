import { authenticateAdmin } from "../utils/authenticate.server";
import { listSyncErrors } from "../../lib/importer/sync/syncErrorLog.server.js";

/**
 * GET /api/sync/errors?limit=200
 */
export const loader = async ({ request }) => {
  const { session } = await authenticateAdmin(request);
  const url = new URL(request.url);
  const limit = Math.min(500, parseInt(url.searchParams.get("limit") || "200", 10) || 200);
  const errors = await listSyncErrors(session.shop, limit);
  return Response.json({ ok: true, errors, total: errors.length });
};
