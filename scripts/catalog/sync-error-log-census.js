#!/usr/bin/env node
/**
 * B1 (corrigido) do briefing de integridade (09/10/2026) — SÓ LEITURA.
 *
 * O aviso "N produto(s) com erro de sincronização pendente" da Curadoria não lê a fila:
 * conta SKUs distintos com SyncErrorLog.active = true (getPollStats). Este censo agrupa
 * essas linhas por mensagem, com SKUs distintos, datas e o estado atual de cada SKU na
 * fila. As mensagens que não indicam "produto não existe" saem à parte.
 *
 * Correr na Fly:
 *   node tmp-integridade/scripts/catalog/sync-error-log-census.js
 *   node tmp-integridade/scripts/catalog/sync-error-log-census.js --all   (inclui as inativas)
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { listCurationQueueItems } from "../../lib/curation/curationQueue.server.js";

const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
const ALL = process.argv.includes("--all");
const NOT_FOUND = /does not exist|not found|n[aã]o existe|n[aã]o encontrad/i;

async function main() {
  const rows = await prisma.syncErrorLog.findMany({
    where: ALL ? { shop: SHOP } : { shop: SHOP, active: true },
    select: { sku: true, message: true, errorType: true, createdAt: true, active: true },
    orderBy: { createdAt: "asc" },
  });
  const distinct = new Set(rows.map((r) => r.sku));
  console.log(`=== sync-error-log-census · SÓ LEITURA · ${rows.length} linhas${ALL ? " (ativas e inativas)" : " ativas"} · ${distinct.size} SKUs distintos ===`);

  const queueStatus = new Map();
  for (const s of ["PENDING", "APPROVED", "REJECTED", "PUBLISHED", "SYNC_ERROR"]) {
    for (const i of await listCurationQueueItems(s)) queueStatus.set(i.sku, s);
  }

  const groups = new Map();
  for (const r of rows) {
    const key = `${ALL ? (r.active ? "ATIVA" : "inativa") + " | " : ""}${r.errorType} | ${String(r.message).slice(0, 160)}`;
    const g = groups.get(key) || { skus: new Set(), first: r.createdAt, last: r.createdAt, status: {} };
    g.skus.add(r.sku);
    if (r.createdAt < g.first) g.first = r.createdAt;
    if (r.createdAt > g.last) g.last = r.createdAt;
    const st = queueStatus.get(r.sku) || "FORA_DA_FILA";
    g.status[st] = (g.status[st] || 0) + 1;
    groups.set(key, g);
  }

  const list = [...groups.entries()]
    .map(([message, g]) => ({ message, ...g, notFound: NOT_FOUND.test(message) }))
    .sort((a, b) => b.skus.size - a.skus.size);

  const print = (title, items) => {
    console.log(`\n## ${title}`);
    if (!items.length) console.log("(nenhuma)");
    for (const g of items) {
      console.log(`${String(g.skus.size).padStart(5)} SKUs  ${g.message}`);
      console.log(`       de ${g.first.toISOString()} a ${g.last.toISOString()}`);
      console.log(`       estado na fila (linhas): ${JSON.stringify(g.status)}`);
      console.log(`       ex.: ${[...g.skus].slice(0, 3).join(", ")}`);
    }
  };
  print('Mensagem "produto não existe na loja"', list.filter((g) => g.notFound));
  print("OUTRAS mensagens (não são produtos apagados)", list.filter((g) => !g.notFound));
}

main()
  .catch((err) => {
    console.error("Erro:", err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect?.());
