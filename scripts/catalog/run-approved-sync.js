#!/usr/bin/env node
/**
 * BRIEFING · Tarefa 5b — publicar o lote aprovado.
 *
 * Runner fino sobre `runApprovedShopifySync` — SEM alterações ao motor de publicação.
 * Corre o sync sobre TODOS os itens APPROVED da fila de curadoria, cronometra, e
 * imprime duração total + ms por produto para comparar com os 54 ms/metafield medidos
 * na Tarefa 8 (essa era só a fase `metafieldsSet` de `alterpop.franchise`; aqui é o
 * publish completo: productCreate + variante + media + ~6 metafields + publish no
 * Online Store + inventário).
 *
 * Correr na Fla:  node scripts/catalog/run-approved-sync.js
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { listCurationQueueItems } from "../../lib/curation/curationQueue.server.js";
import { runApprovedShopifySync } from "../../lib/importer/shopify/shopifyApprovedSync.server.js";

const args = process.argv.slice(2);
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";

async function main() {
  const approvedBefore = (await listCurationQueueItems("APPROVED")).map((i) => i.sku);
  console.log(`=== run-approved-sync (${SHOP}) ===`);
  console.log(`APPROVED na fila: ${approvedBefore.length}`);
  console.log(approvedBefore.map((s) => `  ${s}`).join("\n"));
  if (!approvedBefore.length) {
    console.log(`\nNada a publicar.`);
    return;
  }

  const t0 = Date.now();
  const res = await runApprovedShopifySync({ shop: SHOP }, { skipInit: true });
  const ms = Date.now() - t0;

  console.log(`\n── resultado ──`);
  console.log(JSON.stringify(res, null, 2));
  const n = res.published || 0;
  console.log(`\nduração total: ${(ms / 1000).toFixed(1)}s`);
  console.log(`publicados: ${res.published} · falhados: ${res.failed} · total: ${res.total}`);
  if (n) {
    console.log(`ms por produto (publish completo): ${(ms / n).toFixed(0)} ms`);
    // ~6 metafields/produto no caminho normal (net_price, dimensions, brand, licence,
    // alterpop.franchise, e alterpop.line quando aplicável).
    console.log(`ms por metafield (aprox., ~6/produto): ${(ms / (n * 6)).toFixed(0)} ms  [Tarefa 8: 54 ms só metafieldsSet de franchise]`);
  }

  const approvedAfter = (await listCurationQueueItems("APPROVED")).length;
  const publishedAfter = (await listCurationQueueItems("PUBLISHED")).length;
  console.log(`\nfila depois: APPROVED ${approvedAfter} · PUBLISHED ${publishedAfter}`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
