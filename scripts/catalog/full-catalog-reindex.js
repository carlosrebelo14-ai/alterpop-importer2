#!/usr/bin/env node
/**
 * Reindexação completa OcioStock → SQLite (filtro premium actualizado).
 * Suporta retoma: RESUME=1 ou estado failed com checkpoint no ficheiro de status.
 *
 * Uso:
 *   node scripts/full-catalog-reindex.js
 *   SHOP=jyr17t-wr.myshopify.com node scripts/full-catalog-reindex.js
 *   RESUME=1 SHOP=jyr17t-wr.myshopify.com node scripts/full-catalog-reindex.js
 */
import "dotenv/config";
import { getDefaultConfig } from "../../lib/importer/config.js";
import { loadShopSettings } from "../../lib/importer/settings.server.js";
import { syncCatalogWithProgress } from "../../lib/importer/catalog/syncCatalogWithProgress.server.js";
import { getCatalogProductTotal } from "../../lib/importer/catalog/catalogProductsDb.server.js";
import {
  writeCatalogRebuildStatus,
  readCatalogRebuildStatus,
  canResumeCatalogRebuild,
} from "../../lib/importer/catalog/catalogRebuildStatus.server.js";
import { ensureLocalOcioStockCsv } from "../../lib/importer/catalog/ensureLocalOcioStockCsv.server.js";

const shop = process.env.SHOP || process.env.SHOPIFY_SHOP_URL || "alterpop-store.myshopify.com";
const forceResume = ["1", "true", "yes"].includes(String(process.env.RESUME || "").toLowerCase());

const settings = await loadShopSettings(shop);
const prevStatus = await readCatalogRebuildStatus(shop);
const resume = forceResume || canResumeCatalogRebuild(prevStatus);
const resumeFromScanned = resume
  ? Number(prevStatus.checkpointScanned ?? prevStatus.scanned ?? 0)
  : 0;

await ensureLocalOcioStockCsv(shop, settings);

console.log(`[reindex] Loja: ${shop}`);
console.log(
  resume
    ? `[reindex] RETOMA a partir da linha ${resumeFromScanned.toLocaleString("pt-PT")} (SQLite mantém-se)\n`
    : "[reindex] Importação completa (limpa SQLite primeiro)…\n"
);

await writeCatalogRebuildStatus(shop, {
  state: "running",
  startedAt: new Date().toISOString(),
  finishedAt: null,
  error: null,
  totalRows: resume ? (prevStatus.checkpointIndexed ?? prevStatus.totalRows ?? 0) : 0,
  indexing: true,
  phase: resume ? "resuming" : "streaming",
  resumedFrom: resume ? resumeFromScanned : null,
});

let lastLog = 0;
let lastCheckpoint = { indexed: 0, scanned: 0 };

try {
  const result = await syncCatalogWithProgress(shop, settings, {
    clearFirst: !resume,
    resumeFromScanned,
    skipSmartRules: true,
    skipFacetTranslation: true,
    onProgress({ indexed, scanned, phase }) {
      lastCheckpoint = { indexed, scanned };
      const now = Date.now();
      if (now - lastLog < 2000 && phase === "streaming") return;
      lastLog = now;
      process.stdout.write(
        `\r[reindex] ${phase || "…"} · ${indexed.toLocaleString("pt-PT")} importados · ${scanned.toLocaleString("pt-PT")} linhas lidas   `
      );
    },
    onCheckpoint({ indexed, scanned }) {
      lastCheckpoint = { indexed, scanned };
      writeCatalogRebuildStatus(shop, {
        checkpointScanned: scanned,
        checkpointIndexed: indexed,
        scanned,
        totalRows: indexed,
      }).catch(() => {});
    },
  });

  const totalInDb = await getCatalogProductTotal(shop);
  const dedup = result.deduplication;

  await writeCatalogRebuildStatus(shop, {
    state: "completed",
    finishedAt: new Date().toISOString(),
    error: null,
    totalRows: totalInDb,
    indexing: false,
    checkpointScanned: null,
    checkpointIndexed: null,
    audit: result.audit,
    deduplication: dedup,
  });

  console.log("\n\n[reindex] Concluído.");
  console.log(`  Linhas lidas:    ${(result.audit?.totalLinesRead ?? result.scanned).toLocaleString("pt-PT")}`);
  console.log(`  Importados:      ${(result.audit?.totalImported ?? result.indexed).toLocaleString("pt-PT")}`);
  console.log(`  Rejeitados:      ${(result.audit?.totalRejected ?? 0).toLocaleString("pt-PT")}`);
  if (dedup?.removed) {
    console.log(
      `  Duplicados:      ${dedup.removed.toLocaleString("pt-PT")} removido(s) em ${dedup.groupsFound} grupo(s)`
    );
  }
  console.log(`  Total na SQLite: ${totalInDb.toLocaleString("pt-PT")}`);
  if (result.audit?.rejectionReasons) {
    console.log("  Motivos (top):", result.audit.rejectionReasons);
  }
} catch (err) {
  await writeCatalogRebuildStatus(shop, {
    state: "failed",
    finishedAt: new Date().toISOString(),
    error: err?.message || String(err),
    indexing: false,
    checkpointScanned: lastCheckpoint.scanned || null,
    checkpointIndexed: lastCheckpoint.indexed || null,
    message: "Indexação interrompida — corre com RESUME=1 ou clica Atualizar catálogo no dashboard.",
  });
  console.error("\n[reindex] Falhou:", err?.message || err);
  if (err?.stack) console.error(err.stack.split("\n").slice(0, 8).join("\n"));
  process.exit(1);
}
