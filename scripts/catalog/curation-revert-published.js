#!/usr/bin/env node
/**
 * ENTREGA 2 · Tarefa 1 — destravar a fila de curadoria depois da limpeza da loja.
 *
 * A loja Shopify foi apagada à mão (limpeza pré-inaugural de 2026-09). A fila local
 * ficou com ~5420 itens em PUBLISHED apontando a `shopifyProductId` já mortos. O
 * publisher (runApprovedShopifySync) seleciona trabalho SÓ por status local — com 0
 * APPROVED e tudo preso em PUBLISHED, o ciclo não importa nada.
 *
 * Reverte PUBLISHED / SYNC_ERROR → PENDING (NÃO APPROVED: publicação é agora sempre
 * manual, decidida pelo Carlos, produto a produto). Limpa shopifyProductId, publishedAt
 * e sync errors. `revertAllPublishedInQueue({ targetStatus })` faz o trabalho.
 *
 * DRY-RUN por defeito (conta por status, não escreve). `--execute` aplica.
 * `--to approved` força o alvo clássico (reset de emergência) — não é o caso aqui.
 *
 * Precisa do curation-queue.json (na Fly: /app/data/curation-queue.json). Correr na Fly.
 *   node scripts/catalog/curation-revert-published.js
 *   node scripts/catalog/curation-revert-published.js --execute
 */
import { loadCurationQueue } from "../../lib/curation/curationQueue.server.js";
import { revertAllPublishedInQueue } from "../../lib/importer/shopify/shopifyReset.server.js";
import { deactivateAllSyncErrors } from "../../lib/importer/sync/syncErrorLog.server.js";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const TARGET =
  args.indexOf("--to") >= 0 && String(args[args.indexOf("--to") + 1]).toUpperCase() === "APPROVED"
    ? "APPROVED"
    : "PENDING";
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";

async function main() {
  const queue = await loadCurationQueue();
  const items = queue.items || [];
  const byStatus = {};
  let withPid = 0;
  for (const it of items) {
    byStatus[it.status] = (byStatus[it.status] || 0) + 1;
    if (it.metadata?.shopifyProductId) withPid++;
  }
  const affected = items.filter(
    (it) =>
      it.status === "PUBLISHED" ||
      it.status === "SYNC_ERROR" ||
      it.metadata?.shopifyProductId
  ).length;

  console.log(`=== curation-revert-published (${SHOP})${EXECUTE ? "" : " · DRY-RUN"} ===`);
  console.log(`fila: ${items.length} itens`);
  console.log(JSON.stringify(byStatus, null, 2));
  console.log(`com shopifyProductId: ${withPid}`);
  console.log(`a reverter → ${TARGET}: ${affected}`);

  if (!EXECUTE) {
    console.log(`\nDRY-RUN — nada escrito. Corre com --execute.`);
    return;
  }

  const reverted = await revertAllPublishedInQueue({ targetStatus: TARGET });
  console.log(`\nrevertidos: ${reverted} → ${TARGET} (shopifyProductId/publishedAt limpos)`);

  try {
    await deactivateAllSyncErrors(SHOP);
    console.log(`sync errors antigos desativados.`);
  } catch (err) {
    console.warn(`deactivateAllSyncErrors falhou: ${err?.message || err}`);
  }

  const after = await loadCurationQueue();
  const post = {};
  for (const it of after.items || []) post[it.status] = (post[it.status] || 0) + 1;
  console.log(`\nfila depois:`);
  console.log(JSON.stringify(post, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
