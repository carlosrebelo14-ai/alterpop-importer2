#!/usr/bin/env node
/**
 * Stream import dry-run (axios + csv-parser, p-limit, SYNC_LIMIT).
 * Usage: SYNC_LIMIT=5 node scripts/stream-import-dry-run.js
 */
import { runImport } from "../lib/importer/jobs/runImport.js";

const limit = parseInt(process.env.SYNC_LIMIT || "5", 10);
process.env.DRY_RUN = process.env.DRY_RUN ?? "true";

async function main() {
  const summary = await runImport({
    dryRun: true,
    settings: {
      syncLimit: limit,
      translateToEnglish: true,
      syncImages: false,
      syncPrices: false,
      translationProvider: "passthrough",
    },
  });

  console.log("Stream dry-run complete");
  console.log(JSON.stringify({ metrics: summary.metrics, stream: summary.stream }, null, 2));
  console.log(`Results: results/${summary.jobId}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
