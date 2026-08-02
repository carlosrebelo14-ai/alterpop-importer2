#!/usr/bin/env node
/**
 * P0.7 — Teste de carga controlado (DRY_RUN, sem API Shopify).
 * Usage: node scripts/load-test-dry-run.js [limit]
 *
 * Requer .env: DRY_RUN=true, SYNC_LIMIT (override opcional via argv).
 * Valida: SKU, preço > 0, stock >= 0. Glossário ES→EN + curadoria ACTIVE/DRAFT.
 */
import fs from "fs/promises";
import path from "path";
import { config } from "../../lib/importer/config.js";
import { runImport } from "../../lib/importer/jobs/runImport.js";

const limit = parseInt(process.argv[2] || String(config.import.syncLimit || 10), 10);

async function main() {
  if (!config.import.dryRun) {
    console.error("ABORT: DRY_RUN deve ser true no .env para este script");
    process.exit(1);
  }

  console.log("=== Alterpop P0.7 Load Test (DRY_RUN + Curadoria) ===");
  console.log(`SYNC_LIMIT=${limit} | DRY_RUN=${config.import.dryRun}`);
  console.log("Glossário: lib/importer/transform/glossary/categories.json");
  console.log("Curadoria: config/curation.json");
  console.log("");

  const summary = await runImport({
    dryRun: true,
    loadTest: true,
    settings: {
      syncLimit: limit,
      syncProducts: true,
      syncInventory: true,
      translateToEnglish: true,
      translationProvider: "passthrough",
      syncImages: true,
      syncPrices: true,
    },
  });

  const resultsDir = path.join(config.paths.results, summary.jobId);
  let curatedSample = [];
  try {
    const curatedRaw = await fs.readFile(path.join(resultsDir, "curated-drafts.json"), "utf8");
    const curated = JSON.parse(curatedRaw);
    curatedSample = (curated.entries || []).slice(0, 5);
  } catch {
    /* sem drafts */
  }

  let activeSample = [];
  try {
    const successRaw = await fs.readFile(path.join(resultsDir, "success.json"), "utf8");
    const success = JSON.parse(successRaw);
    activeSample = success
      .filter((e) => e.shopifyStatus === "ACTIVE")
      .slice(0, 3)
      .map((e) => ({
        sku: e.sku,
        vendor: e.vendor,
        category: e.category,
        reasons: e.curationReasons,
      }));
  } catch {
    /* skip */
  }

  console.log("");
  console.log("=== Resumo ===");
  console.log(JSON.stringify(summary.metrics, null, 2));
  console.log("");
  console.log("=== Curadoria (amostra DRAFT) ===");
  if (curatedSample.length === 0) {
    console.log("(nenhum produto enviado para DRAFT)");
  } else {
    console.log(JSON.stringify(curatedSample, null, 2));
  }
  console.log("");
  console.log("=== Curadoria (amostra ACTIVE) ===");
  console.log(JSON.stringify(activeSample, null, 2));
  console.log("");
  console.log(`Resultados: results/${summary.jobId}/`);
  console.log("  - success.json");
  console.log("  - curated-drafts.json");
  console.log("  - validation-skipped.json");
  console.log("  - failed.json");
  console.log("  - missing_glossary.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
