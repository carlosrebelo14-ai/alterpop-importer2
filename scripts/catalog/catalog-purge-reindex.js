#!/usr/bin/env node
/**
 * Limpeza geral do catálogo Prisma + reindexação OcioStock (exclude-list activo).
 *
 * Ação DESTRUTIVA — apaga o catálogo Prisma da loja indicada. SHOP e CONFIRM
 * são obrigatórios, sem fallback, para evitar apagar a loja errada por engano.
 *
 * Uso:
 *   SHOP=alterpop-store.myshopify.com CONFIRM=APAGAR node scripts/catalog/catalog-purge-reindex.js
 */
import "dotenv/config";
import { loadShopSettings } from "../../lib/importer/settings.server.js";
import { startCatalogCleanupInBackground } from "../../lib/importer/catalog/catalogRebuild.server.js";
import { readCatalogRebuildStatus } from "../../lib/importer/catalog/catalogRebuild.server.js";
import { marcarAtividadeApp, recusarSeAtividadeApp } from "../../lib/curation/atividadeApp.js";

const CONFIRM_WORD = "APAGAR";

// D7 (Decisão 35): a purga escreve a fila pelo worker. Recusa com indexação ou publicação em curso.
recusarSeAtividadeApp("catalog-purge-reindex");

const shop = process.env.SHOP;
if (!shop) {
  console.error(
    "[catalog-purge] ABORTADO: variável SHOP não definida.\n" +
      "Este script apaga o catálogo Prisma da loja indicada — não há loja por defeito.\n" +
      "Uso: SHOP=<loja>.myshopify.com CONFIRM=APAGAR node scripts/catalog/catalog-purge-reindex.js"
  );
  process.exit(1);
}

if (process.env.CONFIRM !== CONFIRM_WORD) {
  console.error(
    `[catalog-purge] ABORTADO: falta confirmação explícita para apagar o catálogo de "${shop}".\n` +
      `Corre novamente com CONFIRM=${CONFIRM_WORD}:\n` +
      `SHOP=${shop} CONFIRM=${CONFIRM_WORD} node scripts/catalog/catalog-purge-reindex.js`
  );
  process.exit(1);
}

// PR 5 (revisão): o processo da purga marca-se como script antes de arrancar o worker. Sem isto, há uma janela entre a
// verificação acima e a marca da corrida, e a indexação da app arrancava nessa janela. O processo da purga não se recusa
// a si próprio, porque a guarda ignora as marcas deste processo.
let retirarMarcador;
try {
  retirarMarcador = marcarAtividadeApp({ tipo: "indexacao", origem: "script" });
} catch {
  console.error("[catalog-purge] Recusado: não foi possível marcar a atividade da app. Nada foi apagado.");
  process.exit(1);
}
// PR 5 (revisão): num sinal (SIGHUP, SIGINT, SIGTERM) a marca é retirada antes de sair. SIGKILL não passa por aqui: a
// marca fica com o pid morto, e a app ignora-a. Ver full-catalog-reindex.js. O worker filho sai com o pai
// (catalog-index-worker.mjs), por isso não fica a escrever órfão.
for (const sinal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.on(sinal, () => {
    retirarMarcador();
    process.exit(sinal === "SIGINT" ? 130 : 143);
  });
}

const settings = await loadShopSettings(shop);

console.log(`[catalog-purge] Loja: ${shop}`);
// DBG-155: a espera é pela corrida toda. Só depois de "closed" o estado final está no disco.
let concluiu;
try {
  concluiu = await startCatalogCleanupInBackground(shop, settings, { causa: "script" });
} catch (err) {
  retirarMarcador();
  console.error("[catalog-purge] Falhou:", err?.message || err);
  process.exit(1);
}
retirarMarcador();

// PR 5 (revisão): só "done" conta como concluída. Recusa, falha e falha de marcador não são sucesso.
if (concluiu === false) {
  console.error("[catalog-purge] Não concluiu: a indexação foi recusada, falhou ou não arrancou. Vê indexing_status antes de repetir.");
  process.exit(1);
}

const status = await readCatalogRebuildStatus(shop);
if (status?.state === "failed") {
  // O texto do erro fica no estado. No log sai só a causa.
  console.error(`[catalog-purge] Falhou: causa=${status.lastFailure?.causa || "desconhecida"}. Ver indexing_status.`);
  process.exit(1);
}
console.log(status?.purge?.message || status?.message || "Concluído.");
if (status?.totalRows != null) {
  console.log(`[catalog-purge] Total após reindexação: ${status.totalRows}`);
}
