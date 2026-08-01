/**
 * Worker fork — indexação CSV → SQLite com eventos para SSE.
 * argv: JSON { shop, settings, runPurge, resume, checkpointScanned }
 */
import { syncCatalogWithProgress } from "../importer/catalog/syncCatalogWithProgress.server.js";
import { purgeDatabase } from "../importer/catalog/purgeDatabase.server.js";
import { ensureLocalOcioStockCsv } from "../importer/catalog/ensureLocalOcioStockCsv.server.js";
import { writeCatalogRebuildStatus } from "../importer/catalog/catalogRebuildStatus.server.js";

const payload = JSON.parse(process.argv[2] || "{}");
const { shop, settings = {}, runPurge = false, resume = false, checkpointScanned = 0 } = payload;

function send(msg) {
  if (process.send) process.send(msg);
}

(async () => {
  try {
    send({ type: "started", shop, resume, at: new Date().toISOString() });

    send({ type: "progress", phase: "csv-cache", indexed: 0, scanned: 0 });
    await ensureLocalOcioStockCsv(shop, settings);

    if (runPurge) {
      send({ type: "progress", phase: "purge", indexed: 0, scanned: 0 });
      const purge = await purgeDatabase(shop);
      send({ type: "purge_done", purge });
    }

    const resumeFromScanned = resume ? Math.max(0, Number(checkpointScanned) || 0) : 0;
    const isResume = resumeFromScanned > 0;

    if (isResume) {
      await writeCatalogRebuildStatus(shop, {
        state: "running",
        indexing: true,
        error: null,
        resumedFrom: resumeFromScanned,
        message: `A retomar a partir da linha ${resumeFromScanned.toLocaleString("pt-PT")} do CSV…`,
      });
      send({
        type: "progress",
        phase: "resuming",
        indexed: 0,
        scanned: resumeFromScanned,
        resumedFrom: resumeFromScanned,
      });
    }

    let sampleCounter = 0;
    const result = await syncCatalogWithProgress(shop, settings, {
      clearFirst: !isResume && !runPurge,
      resumeFromScanned,
      onProgress(stats) {
        send({ type: "progress", ...stats });
      },
      onCheckpoint({ indexed, scanned }) {
        writeCatalogRebuildStatus(shop, {
          checkpointScanned: scanned,
          checkpointIndexed: indexed,
          scanned,
          totalRows: indexed,
        }).catch(() => {});
      },
    });

    await writeCatalogRebuildStatus(shop, {
      checkpointScanned: null,
      checkpointIndexed: null,
      resumedFrom: null,
      message: null,
    });

    send({
      type: "done",
      indexed: result.indexed,
      scanned: result.scanned,
      finishedAt: new Date().toISOString(),
      audit: result.audit,
      totalLinesRead: result.audit?.totalLinesRead ?? result.scanned,
      totalImported: result.audit?.totalImported ?? result.indexed,
      totalRejected: result.audit?.totalRejected ?? 0,
      rejectionReasons: result.audit?.rejectionReasons ?? {},
    });
    process.exit(0);
  } catch (err) {
    send({
      type: "error",
      message: err?.message || String(err),
    });
    process.exit(1);
  }
})();
