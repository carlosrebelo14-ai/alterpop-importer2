import { authenticateAdmin } from "../utils/authenticate.server";
import { parseImportStartFromForm } from "../../lib/importer/jobs/parseImportStart.server.js";
import { startImportJob } from "../../lib/importer/jobs/jobRunner.server.js";

/**
 * POST /api/import/start
 * Enfileira importação em background — resposta imediata com jobId.
 */
export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  const { session } = await authenticateAdmin(request);
  const form = await request.formData();
  const parsed = await parseImportStartFromForm(form, session);

  if (parsed.error) {
    return Response.json({ ok: false, error: parsed.error }, { status: 400 });
  }

  const result = await startImportJob({
    session,
    settings: parsed.settings,
    dryRun: parsed.dryRun,
    productsOnly: parsed.productsOnly,
    inventoryOnly: parsed.inventoryOnly,
    filters: parsed.filters,
  });

  return Response.json({
    ok: true,
    jobId: result.jobId,
    state: result.state,
    queueId: result.queueId,
  });
};
