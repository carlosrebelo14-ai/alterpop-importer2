import { authenticateAdmin } from "../utils/authenticate.server";
import { listRecentSyncJobs } from "../../lib/importer/shopify/syncJobHistory.server.js";

/** GET /api/sync/jobs?limit=10 — histórico de corridas (item 16 do roadmap). */
export const loader = async ({ request }) => {
  const { session } = await authenticateAdmin(request);
  const url = new URL(request.url);
  const limit = Math.min(100, parseInt(url.searchParams.get("limit") || "10", 10) || 10);

  const jobs = await listRecentSyncJobs(session.shop, limit);

  return Response.json({
    ok: true,
    jobs: jobs.map((j) => ({
      id: j.id,
      startedAt: j.startedAt.toISOString(),
      finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
      received: j.received,
      succeeded: j.succeeded,
      failed: j.failed,
      status: j.status,
    })),
  });
};
