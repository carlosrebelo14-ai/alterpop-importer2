#!/usr/bin/env node
/**
 * Passo 4 da revisão de 08/10/2026 — medir o custo do alerta de erosão de margem num
 * ciclo real, antes do merge. SÓ LEITURA: não grava o estado do alerta nem escreve na
 * loja.
 *
 * Faz as mesmas leituras à Shopify que reconcileMarginErosionCycle
 * (lib/importer/curation/marginErosion.server.js): variantes live dos PUBLISHED e dos
 * itens com preço fixado na curadoria, mais o diagnóstico dos que não existem na loja.
 * Conta cada pedido GraphQL e mede o tempo de cada fase. A leitura do catálogo
 * (SQLite local) também é medida, sem a coluna distributorPrice, que só existe depois
 * do deploy.
 *
 * Corre na Fly:
 *   node scripts/catalog/margin-erosion-measure.js
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { listCurationQueueItems } from "../../lib/curation/curationQueue.server.js";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { fetchLiveVariantsBySku, diagnoseMissingLive } from "../../lib/importer/shopify/liveVariantsBySku.server.js";

const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";

/** Cliente que conta pedidos por operação e soma o tempo de cada um. */
function countingClient(client) {
  const byOp = new Map();
  return {
    byOp,
    total: () => [...byOp.values()].reduce((s, o) => s + o.count, 0),
    async graphql(query, vars) {
      const op = (String(query).match(/(?:query|mutation)\s+(\w+)/) || [])[1] || "anon";
      const t0 = Date.now();
      try {
        return await client.graphql(query, vars);
      } finally {
        const o = byOp.get(op) || { count: 0, ms: 0 };
        o.count += 1;
        o.ms += Date.now() - t0;
        byOp.set(op, o);
      }
    },
  };
}

async function timed(label, fn) {
  const t0 = Date.now();
  const r = await fn();
  console.log(`  ${label.padEnd(44)} ${String(Date.now() - t0).padStart(6)} ms`);
  return r;
}

async function main() {
  console.log(`=== margin-erosion-measure (${SHOP}) · SÓ LEITURA ===\n`);
  const tAll = Date.now();

  const allItems = await timed("fila de curadoria (leitura)", () => listCurationQueueItems());
  const published = allItems.filter((i) => i.sku && i.status === "PUBLISHED");
  const withOverride = allItems.filter((i) => i.sku && Number(i.metadata?.overrides?.price) > 0);
  const skus = [...new Set([...published.map((i) => i.sku), ...withOverride.map((i) => i.sku)])];
  console.log(`    PUBLISHED: ${published.length} · com preço fixado: ${withOverride.length} · SKUs a ler: ${skus.length}`);

  await timed("catálogo (SQLite, SKUs publicados)", () =>
    prisma.catalogProduct.findMany({ where: { shop: SHOP, sku: { in: published.map((i) => i.sku) } }, select: { sku: true, title: true } })
  );

  const session = await loadOfflineSessionForShop(SHOP);
  const client = countingClient(createShopifyClientFromSession(session));

  const live = await timed("Shopify: variantes live por SKU", () => fetchLiveVariantsBySku(client, skus));
  const orphans = published.filter((i) => !live.has(i.sku));
  await timed(`Shopify: diagnóstico de ${orphans.length} sem produto`, () => diagnoseMissingLive(client, orphans));

  const totalMs = Date.now() - tAll;
  console.log(`\n--- Pedidos à Shopify ---`);
  for (const [op, o] of client.byOp) console.log(`  ${op.padEnd(28)} ${String(o.count).padStart(4)} pedido(s) · ${o.ms} ms`);
  console.log(`  ${"TOTAL".padEnd(28)} ${String(client.total()).padStart(4)} pedido(s)`);
  console.log(`\nDuração total: ${totalMs} ms (${(totalMs / 1000).toFixed(1)} s)`);
  console.log(`Escala: 1 pedido por 40 SKUs + 1 por publicado sem produto + 1 de eventos se houver apagados.`);
  console.log("Nada foi gravado nem escrito.");
}

main()
  .catch((err) => {
    console.error(err?.stack || err?.message || err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
