import { authenticateAdmin } from "../utils/authenticate.server";
import fs from "fs/promises";
import path from "path";
import { getDefaultConfig } from "../../lib/importer/config.js";
import { parseImportStartFromForm } from "../../lib/importer/jobs/parseImportStart.server.js";
import { startImportJob } from "../../lib/importer/jobs/jobRunner.server.js";

/**
 * POST /api/import/retry-failed — reenfileira SKUs de failed.json ou failed-batches.json.
 * Body: jobId (obrigatório), dryRun opcional via form.
 */
export const action = async ({ request }) => {
  const { session } = await authenticateAdmin(request);
  const form = await request.formData();
  const jobId = form.get("jobId");
  if (!jobId) {
    return Response.json({ ok: false, error: "jobId obrigatório" }, { status: 400 });
  }

  const resultsDir = path.join(getDefaultConfig().paths.results, String(jobId));
  /** @type {string[]} */
  let skus = [];

  try {
    const failedBatches = JSON.parse(
      await fs.readFile(path.join(resultsDir, "failed-batches.json"), "utf8")
    );
    skus = failedBatches.retrySkus || [];
  } catch {
    /* try failed.json */
  }

  if (!skus.length) {
    try {
      const failed = JSON.parse(await fs.readFile(path.join(resultsDir, "failed.json"), "utf8"));
      skus = [...new Set(failed.map((f) => f.sku).filter(Boolean))];
    } catch {
      return Response.json({ ok: false, error: "Sem falhas para retry neste job" }, { status: 404 });
    }
  }

  if (!skus.length) {
    return Response.json({ ok: false, error: "Lista de SKUs vazia" }, { status: 404 });
  }

  const parsed = await parseImportStartFromForm(form, session);
  if (parsed.error) {
    return Response.json({ ok: false, error: parsed.error }, { status: 400 });
  }

  const settings = {
    ...parsed.settings,
    skuAllowlist: skus.join(", "),
    syncLimit: skus.length,
  };

  const result = await startImportJob({
    session,
    settings,
    dryRun: parsed.dryRun,
    filters: parsed.filters,
    productsOnly: parsed.productsOnly,
    inventoryOnly: parsed.inventoryOnly,
  });

  return Response.json({
    ok: true,
    jobId: result.jobId,
    state: result.state,
    retryCount: skus.length,
  });
};
