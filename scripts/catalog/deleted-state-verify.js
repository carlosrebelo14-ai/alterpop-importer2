#!/usr/bin/env node
/**
 * SÓ LEITURA. Verifica o resultado da migração dos produtos apagados no admin
 * (curation-mark-deleted.js): quantos itens da fila têm metadata.deletedInAdmin, em que
 * estado estão, se têm a nota e o selo, e quantos APPROVED há no total.
 * Sai com código 1 se algum item apagado estiver fora de PENDING sem decisão humana
 * (APPROVED), ou sem nota/selo, ou se a contagem não for a esperada (--expect N).
 *
 *   node scripts/catalog/deleted-state-verify.js --expect 157
 * Lista também, dos SKUs com «Produto/variante não encontrado» no SyncErrorLog, os que NÃO
 * têm a marca (estado atual e chaves da metadata), para diagnosticar divergências.
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { loadCurationQueue } from "../../lib/curation/curationQueue.server.js";

const args = process.argv.slice(2);
const ei = args.indexOf("--expect");
const EXPECT = ei >= 0 ? Number(args[ei + 1]) : null;

async function main() {
  const queue = await loadCurationQueue();
  const deleted = queue.items.filter((i) => i.metadata?.deletedInAdmin);
  const byStatus = {};
  for (const i of deleted) byStatus[i.status] = (byStatus[i.status] || 0) + 1;
  const noNote = deleted.filter((i) => i.metadata.deletedInAdmin.note !== "apagado no admin" || !i.metadata.deletedInAdmin.at);
  const noBadge = deleted.filter((i) => i.metadata.wasPublished !== true);
  const approved = deleted.filter((i) => i.status === "APPROVED");
  const approvedTotal = queue.items.filter((i) => i.status === "APPROVED").length;
  const byDay = {};
  for (const i of deleted) {
    const d = String(i.metadata.deletedInAdmin.at).slice(0, 10);
    byDay[d] = (byDay[d] || 0) + 1;
  }

  console.log("=== deleted-state-verify · SÓ LEITURA ===\n");
  console.log(`Itens com deletedInAdmin: ${deleted.length}${EXPECT != null ? ` (esperado ${EXPECT})` : ""}`);
  console.log(`  por estado:         ${JSON.stringify(byStatus)}`);
  console.log(`  por dia da marca:   ${JSON.stringify(byDay)}`);
  console.log(`  sem nota/data:      ${noNote.length}`);
  console.log(`  sem selo (wasPublished): ${noBadge.length}`);
  console.log(`  em APPROVED:        ${approved.length}`);
  console.log(`APPROVED na fila toda: ${approvedTotal}`);
  if (approved.length) console.log(`  APPROVED apagados: ${approved.map((i) => i.sku).join(", ")}`);

  // SKUs do log que deviam ter a marca e não a têm.
  const logRows = await prisma.syncErrorLog.findMany({
    where: { message: { contains: "Produto/variante não encontrado na Shopify" } },
    select: { sku: true },
    distinct: ["sku"],
  });
  const bySku = new Map(queue.items.map((i) => [i.sku, i]));
  const missing = logRows.map((r) => r.sku).filter((sku) => !bySku.get(sku)?.metadata?.deletedInAdmin);
  console.log(`\nSKUs do log sem a marca: ${missing.length} (de ${logRows.length})`);
  for (const sku of missing) {
    const it = bySku.get(sku);
    const m = it?.metadata || {};
    console.log(`  ${sku.padEnd(16)} ${String(it?.status ?? "FORA DA FILA").padEnd(10)} reason=${it?.reason ?? "—"} shopifyStatus=${it?.shopifyStatus ?? "—"} chaves=[${Object.keys(m).sort().join(",")}] lastSeenAt=${m.lastSeenAt ?? "—"} smartRule=${m.smartRule ?? "—"} elite=${m.eliteAction ?? "—"}`);
  }

  const problems = [];
  if (EXPECT != null && deleted.length !== EXPECT) problems.push(`contagem ${deleted.length} ≠ ${EXPECT}`);
  if (noNote.length) problems.push(`${noNote.length} sem nota/data`);
  if (noBadge.length) problems.push(`${noBadge.length} sem selo`);
  if (approved.length) problems.push(`${approved.length} em APPROVED`);
  const notPending = deleted.filter((i) => i.status !== "PENDING" && i.status !== "APPROVED");
  if (notPending.length) console.log(`  (fora de PENDING por decisão posterior: ${notPending.length})`);
  if (problems.length) {
    console.error(`\n✗ ${problems.join("; ")}`);
    process.exitCode = 1;
  } else {
    console.log("\n✓ todos PENDING com nota, data e selo; nenhum em APPROVED.");
  }
}

main()
  .catch((err) => {
    console.error("Erro:", err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect?.());
