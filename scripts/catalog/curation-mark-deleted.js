#!/usr/bin/env node
/**
 * Os produtos que o Carlos apagou no admin e que estão REJECTED na fila voltam a PENDING,
 * com a nota "apagado no admin" e a data (decisão de 09/10/2026: apagar tira da loja, o
 * produto volta à curadoria e só é republicado com aprovação nova dele). Nunca APPROVED.
 *
 * Candidatos: SKUs com SyncErrorLog "Produto/variante não encontrado na Shopify" (ativo ou
 * não). Só migra quem tem prova de que não existe (sem variante com o SKU e, havendo id de
 * produto guardado, product(id) inexistente) e está REJECTED ou SYNC_ERROR. O resto sai à
 * vista com a razão.
 *
 * DRY-RUN por omissão: só lê. Escreve só com --execute, e só com o OK do Carlos depois de
 * ler a lista. Recusa escrever com a indexação a correr. Erros → results/errors.json.
 *   node scripts/catalog/curation-mark-deleted.js
 *   node scripts/catalog/curation-mark-deleted.js --execute
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { loadCurationQueue, markQueueItemDeletedInAdmin } from "../../lib/curation/curationQueue.server.js";
import { readCatalogRebuildStatus } from "../../lib/importer/catalog/catalogRebuildStatus.server.js";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { fetchLiveVariantsBySku } from "../../lib/importer/shopify/liveVariantsBySku.server.js";
import { planDeletedMigration } from "../../lib/curation/deletedMigration.js";

const EXECUTE = process.argv.includes("--execute");
const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
const ERRORS_PATH = path.join(process.cwd(), "results", "errors.json");
const NOT_FOUND_MESSAGE = "Produto/variante não encontrado na Shopify";
const PRODUCT_EXISTS = `query MarkDeletedProductExists($id: ID!) { product(id: $id) { id } }`;

function appendErrors(entries) {
  if (!entries.length) return;
  fs.mkdirSync(path.dirname(ERRORS_PATH), { recursive: true });
  let list = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(ERRORS_PATH, "utf8"));
    list = Array.isArray(parsed) ? parsed : [];
  } catch {
    list = [];
  }
  list.push(...entries);
  fs.writeFileSync(ERRORS_PATH, JSON.stringify(list, null, 2), "utf8");
}
const errorEntry = (codigo, sku, mensagem) => ({ operacao: "curation-mark-deleted", codigo, mensagem, timestamp: new Date().toISOString(), contexto: { sku } });

async function main() {
  console.log(`=== curation-mark-deleted (${SHOP})${EXECUTE ? " · EXECUTE" : " · DRY-RUN — nada é escrito"} ===\n`);
  if (EXECUTE) {
    const st = await readCatalogRebuildStatus(SHOP);
    if (st?.indexing || st?.state === "running") {
      console.error("PARADO: indexação a correr — o worker trabalha sobre uma cópia da fila e desfazia a escrita.");
      process.exit(1);
    }
  }

  const logRows = await prisma.syncErrorLog.findMany({
    where: { shop: SHOP, message: { contains: NOT_FOUND_MESSAGE } },
    select: { sku: true },
    distinct: ["sku"],
  });
  const logSkus = logRows.map((r) => r.sku);
  console.log(`SKUs com "${NOT_FOUND_MESSAGE}" no log: ${logSkus.length}`);

  const queue = await loadCurationQueue();
  const itemBySku = new Map(queue.items.map((i) => [i.sku, i]));
  const client = createShopifyClientFromSession(await loadOfflineSessionForShop(SHOP));
  const liveSkus = new Set((await fetchLiveVariantsBySku(client, logSkus)).keys());

  const productExists = new Map();
  const errors = [];
  for (const sku of logSkus) {
    const pid = itemBySku.get(sku)?.metadata?.shopifyProductId;
    if (!pid || liveSkus.has(sku)) continue;
    try {
      productExists.set(sku, Boolean((await client.graphql(PRODUCT_EXISTS, { id: pid })).product));
    } catch (err) {
      productExists.set(sku, null);
      errors.push(errorEntry("product_read_failed", sku, err?.message || String(err)));
    }
  }

  const plan = planDeletedMigration({ logSkus, itemBySku, liveSkus, productExists });
  const migrate = plan.filter((r) => r.action === "MIGRATE");
  const keep = plan.filter((r) => r.action === "KEEP");

  console.log(`\n## A MIGRAR PARA PENDING (${migrate.length})`);
  for (const r of migrate) console.log(`${r.sku.padEnd(16)} ${String(r.status).padEnd(11)} ${itemBySku.get(r.sku)?.title_en || ""}  [${r.proof}]`);
  console.log(`\n## FICAM COMO ESTÃO (${keep.length})`);
  for (const r of keep) console.log(`${r.sku.padEnd(16)} ${String(r.status).padEnd(11)} ${r.reason}`);

  if (!EXECUTE) {
    appendErrors(errors);
    console.log("\nDRY-RUN: nada escrito. Para escrever, depois do OK: --execute");
    return;
  }

  let done = 0;
  for (const r of migrate) {
    try {
      const item = await markQueueItemDeletedInAdmin(r.sku);
      if (item) done += 1;
      else errors.push(errorEntry("not_in_queue", r.sku, "SKU saiu da fila entre a leitura e a escrita"));
    } catch (err) {
      errors.push(errorEntry("write_failed", r.sku, err?.message || String(err)));
    }
  }
  appendErrors(errors);
  const after = new Map((await loadCurationQueue()).items.map((i) => [i.sku, i]));
  const ok = migrate.filter((r) => after.get(r.sku)?.status === "PENDING" && after.get(r.sku)?.metadata?.deletedInAdmin).length;
  console.log(`\nescritos: ${done} · verificados PENDING com nota: ${ok} de ${migrate.length}`);
  if (ok !== migrate.length || errors.length) {
    console.error(`${errors.length} erro(s) — ver results/errors.json`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    appendErrors([errorEntry("fatal", null, err?.message || String(err))]);
    console.error(err?.stack || err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect?.());
