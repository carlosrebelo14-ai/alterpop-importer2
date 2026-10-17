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
  flushCatalogRebuildStatus,
  readCatalogRebuildStatus,
  canResumeCatalogRebuild,
} from "../../lib/importer/catalog/catalogRebuildStatus.server.js";
import { ensureLocalOcioStockCsv } from "../../lib/importer/catalog/ensureLocalOcioStockCsv.server.js";
import { registoDaFalha } from "../../lib/importer/catalog/falhaIndexacao.js";
import { marcarAtividadeApp, recusarSeAtividadeApp } from "../../lib/curation/atividadeApp.js";

// DBG-155 (Decisão 35, D7): esta corrida escreve o estado e a fila. Recusa com atividade da app em curso.
recusarSeAtividadeApp("full-catalog-reindex");

// DBG-155: a corrida marca a atividade da app, como o worker. O marcador leva o pid deste processo e sai no fim.
// PR 5 (DBG-140 e DBG-141): origem "script". A app não arranca indexação nem publicação por cima deste marcador.
let retirarMarcador;
try {
  retirarMarcador = marcarAtividadeApp({ tipo: "indexacao", origem: "script" });
} catch {
  console.error("[reindex] Recusado: não foi possível marcar a atividade da app. Nada foi gravado.");
  process.exit(1);
}

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

// DBG-155: o running vai para o disco antes de a indexação começar (como no worker). Sem ele, a corrida não arranca.
const gravouRunning = await flushCatalogRebuildStatus(shop, {
  state: "running",
  startedAt: new Date().toISOString(),
  finishedAt: null,
  error: null,
  totalRows: resume ? (prevStatus.checkpointIndexed ?? prevStatus.totalRows ?? 0) : 0,
  indexing: true,
  phase: resume ? "resuming" : "streaming",
  resumedFrom: resume ? resumeFromScanned : null,
});
if (!gravouRunning) {
  retirarMarcador();
  console.error("[reindex] Recusado: o estado não ficou gravado no disco. Nada foi indexado.");
  process.exit(1);
}

let lastLog = 0;
let lastCheckpoint = { indexed: 0, scanned: 0 };
let causaFalha = "erro_script";

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

  const gravouFim = await flushCatalogRebuildStatus(shop, {
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
  if (!gravouFim) {
    causaFalha = "estado_nao_gravado";
    throw new Error("estado final não gravado no disco");
  }
  retirarMarcador();

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
  // DBG-155: o failed vai para o disco antes do exit. O texto do erro fica no estado, nunca no log.
  const textoDoErro = err?.message || String(err);
  const gravouFalha = await flushCatalogRebuildStatus(shop, {
    state: "failed",
    finishedAt: new Date().toISOString(),
    error: textoDoErro,
    indexing: false,
    checkpointScanned: lastCheckpoint.scanned || null,
    checkpointIndexed: lastCheckpoint.indexed || null,
    message: "Indexação interrompida — corre com RESUME=1 ou clica Atualizar catálogo no dashboard.",
    lastFailure: registoDaFalha(causaFalha, textoDoErro),
  });
  retirarMarcador();
  console.error(
    `[reindex] Falhou: causa=${causaFalha}. ${gravouFalha ? "Estado gravado como failed." : "Estado NÃO gravado no disco."}`
  );
  process.exit(1);
}
