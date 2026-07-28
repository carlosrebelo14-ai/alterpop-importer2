import { authenticateAdmin } from "../utils/authenticate.server";
import { getJobStatus } from "../../lib/importer/jobs/jobRunner.server.js";

/**
 * GET /api/import/status/:jobId
 * Estado da fila (percentagem, SKU actual, resumo quando terminar).
 */
export const loader = async ({ request, params }) => {
  await authenticateAdmin(request);
  const jobId = params.jobId;

  if (!jobId) {
    return Response.json({ ok: false, error: "jobId required" }, { status: 400 });
  }

  const status = await getJobStatus(jobId);
  if (!status) {
    return Response.json({ ok: false, error: "Job not found" }, { status: 404 });
  }

  return Response.json({ ok: true, ...status });
};
