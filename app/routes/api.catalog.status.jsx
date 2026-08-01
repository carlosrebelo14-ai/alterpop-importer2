import { authenticateAdmin } from "../utils/authenticate.server";
import { isCatalogIndexingRunning } from "../../lib/importer/catalog/indexingStream.server.js";
import {
  canResumeCatalogRebuild,
  readCatalogRebuildStatus,
} from "../../lib/importer/catalog/catalogRebuildStatus.server.js";

/** GET /api/catalog/status — estado da indexação (leve, sem queries à DB). */
export const loader = async ({ request }) => {
  const { session } = await authenticateAdmin(request);
  const fileStatus = await readCatalogRebuildStatus(session.shop);
  
  const running =
    isCatalogIndexingRunning(session.shop) || fileStatus.state === "running";

  return Response.json({
    ok: true,
    rebuilding: running,
    state: running ? "running" : fileStatus.state,
    error: fileStatus.error,
    startedAt: fileStatus.startedAt,
    finishedAt: fileStatus.finishedAt,
    purge: fileStatus.purge || null,
    message: fileStatus.message || fileStatus.purge?.message || null,
    audit: fileStatus.audit || null,
    totalLinesRead: fileStatus.totalLinesRead ?? null,
    totalImported: fileStatus.totalImported ?? null,
    totalRejected: fileStatus.totalRejected ?? null,
    rejectionReasons: fileStatus.rejectionReasons ?? null,
    canResume: canResumeCatalogRebuild(fileStatus),
    checkpointScanned: fileStatus.checkpointScanned ?? fileStatus.scanned ?? null,
    checkpointIndexed: fileStatus.checkpointIndexed ?? fileStatus.totalRows ?? null,
    statusMessage: fileStatus.message || null,
  });
};
