import fs from "fs/promises";
import path from "path";
import { authenticateAdmin } from "../utils/authenticate.server";
import { getDefaultConfig } from "../../lib/importer/config.js";

/**
 * GET /api/import/results/:jobId/summary — descarrega summary.json do job.
 */
export const loader = async ({ request, params }) => {
  await authenticateAdmin(request);
  const jobId = params.jobId;
  if (!jobId || jobId.includes("..")) {
    return new Response("Invalid jobId", { status: 400 });
  }

  const filePath = path.join(getDefaultConfig().paths.results, jobId, "summary.json");

  try {
    const raw = await fs.readFile(filePath, "utf8");
    return new Response(raw, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="summary-${jobId}.json"`,
      },
    });
  } catch {
    return new Response("Summary not found", { status: 404 });
  }
};
