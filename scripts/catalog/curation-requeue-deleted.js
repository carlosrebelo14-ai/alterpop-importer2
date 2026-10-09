#!/usr/bin/env node
/**
 * Fila PUBLISHED cujo produto foi apagado na Shopify → volta ao fluxo de publicação
 * (V19 do portão de saúde, 09/10/2026).
 *
 * Em 08/10/2026 o Carlos apagou à mão, no admin, 157 produtos publicados para os voltar
 * a importar com o preço novo (PR #87). A fila continuou PUBLISHED a apontar a
 * shopifyProductId mortos, e o publisher (runApprovedShopifySync) só pega em APPROVED —
 * sem isto, nunca mais seriam criados.
 *
 * Diferente de curation-revert-published.js, que reverte TODOS os PUBLISHED: aqui só
 * mudam os itens com prova dupla de que o produto já não existe —
 *   1. nenhuma variante live com o SKU (fetchLiveVariantsBySku), e
 *   2. product(id) do shopifyProductId guardado devolve null.
 * Os que continuam na loja (ex.: os 4 Gandalf) e os que não se conseguem confirmar
 * ficam como estão, listados com o motivo.
 *
 * Destino ÚNICO: PENDING (decisão do Carlos, 09/10/2026). O produto apagado volta à
 * curadoria com a nota "apagado no admin" e a data, e só é republicado com aprovação
 * nova dele. A app nunca recria nada sozinha: `--to approved` é recusado. A escrita é a
 * de markQueueItemDeletedInAdmin (a mesma da ação "aplicar aos publicados").
 * Recusa escrever com uma indexação a correr — o worker trabalha sobre uma cópia da fila
 * e repunha PUBLISHED no flush.
 *
 * DRY-RUN por omissão. Escreve só com --execute. Erros → results/errors.json.
 * Correr na Fly:
 *   node scripts/catalog/curation-requeue-deleted.js
 *   node scripts/catalog/curation-requeue-deleted.js --execute
 */
import fs from "node:fs";
import path from "node:path";
import { loadCurationQueue, markQueueItemDeletedInAdmin } from "../../lib/curation/curationQueue.server.js";
import { readCatalogRebuildStatus } from "../../lib/importer/catalog/catalogRebuildStatus.server.js";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { fetchLiveVariantsBySku } from "../../lib/importer/shopify/liveVariantsBySku.server.js";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const toArg = args.indexOf("--to") >= 0 ? String(args[args.indexOf("--to") + 1] || "").toUpperCase() : null;
const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
const ERRORS_PATH = path.join(process.cwd(), "results", "errors.json");

const PRODUCT_EXISTS = `
  query RequeueProductExists($id: ID!) {
    product(id: $id) { id status }
  }
`;

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

const errorEntry = (codigo, sku, mensagem, contexto = {}) => ({
  operacao: "curation-requeue-deleted",
  codigo,
  mensagem,
  timestamp: new Date().toISOString(),
  contexto: { sku, ...contexto },
});

async function indexingRunning() {
  const status = await readCatalogRebuildStatus(SHOP);
  return Boolean(status?.indexing) || status?.state === "running";
}

async function main() {
  console.log(`=== curation-requeue-deleted (${SHOP})${EXECUTE ? "" : " · DRY-RUN"} ===\n`);
  if (toArg && toArg !== "PENDING") {
    console.error("PARADO: o único destino é PENDING — um produto apagado no admin só volta com aprovação nova do Carlos (--to approved já não existe).");
    process.exit(1);
  }

  const published = (await loadCurationQueue()).items.filter((i) => i.sku && i.status === "PUBLISHED");
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);
  const live = await fetchLiveVariantsBySku(
    client,
    published.map((i) => i.sku)
  );

  const deleted = [];
  const kept = [];
  const errors = [];
  for (const item of published) {
    if (live.has(item.sku)) {
      kept.push({ sku: item.sku, reason: "variante live com este SKU — fica PUBLISHED" });
      continue;
    }
    const pid = item.metadata?.shopifyProductId;
    if (!pid) {
      kept.push({ sku: item.sku, reason: "sem shopifyProductId guardado — não se confirma o apagamento" });
      continue;
    }
    try {
      const data = await client.graphql(PRODUCT_EXISTS, { id: pid });
      if (data.product) {
        kept.push({ sku: item.sku, reason: `produto ${pid} existe (${data.product.status}) com outro SKU — fica PUBLISHED` });
      } else {
        deleted.push({ sku: item.sku, pid });
      }
    } catch (err) {
      const msg = err?.message || String(err);
      kept.push({ sku: item.sku, reason: `leitura de ${pid} falhou: ${msg}` });
      errors.push(errorEntry("product_read_failed", item.sku, msg, { shopifyProductId: pid }));
    }
  }

  console.log(`PUBLISHED na fila: ${published.length}`);
  console.log(`  apagados na loja (confirmado): ${deleted.length}`);
  console.log(`  ficam como estão:              ${kept.length}`);
  for (const k of kept) console.log(`    ${k.sku.padEnd(16)} ${k.reason}`);

  if (!EXECUTE) {
    appendErrors(errors);
    console.log(`\nDRY-RUN — nada escrito. Para escrever:`);
    console.log(`  node scripts/catalog/curation-requeue-deleted.js --execute   # voltam a PENDING, com a nota "apagado no admin"`);
    return;
  }

  if (await indexingRunning()) {
    errors.push(errorEntry("indexing_running", null, "indexação a correr — nada escrito"));
    appendErrors(errors);
    console.error("\nPARADO: indexação a correr (o worker repunha PUBLISHED). Espera que termine e corre de novo.");
    process.exit(1);
  }

  // Só muda os confirmados que continuam PUBLISHED com o mesmo shopifyProductId (relido
  // imediatamente antes de gravar); a escrita é markQueueItemDeletedInAdmin → PENDING.
  const queue = await loadCurationQueue();
  const bySku = new Map(deleted.map((d) => [d.sku, d.pid]));
  let changed = 0;
  for (const item of queue.items) {
    const pid = bySku.get(item.sku);
    if (!pid || item.status !== "PUBLISHED" || item.metadata?.shopifyProductId !== pid) continue;
    await markQueueItemDeletedInAdmin(item.sku);
    changed += 1;
  }
  if (changed !== deleted.length) {
    errors.push(
      errorEntry("queue_changed_since_read", null, `${deleted.length - changed} item(s) mudaram na fila entre a leitura e a escrita — não tocados`)
    );
  }
  appendErrors(errors);

  const after = (await loadCurationQueue()).items;
  const ok = after.filter((i) => bySku.has(i.sku) && i.status === "PENDING" && i.metadata?.shopifyProductId == null).length;
  console.log(`\nescritos: ${changed} → PENDING · verificados na fila: ${ok}`);
  if (ok !== changed) {
    appendErrors([errorEntry("verify_failed", null, `verificados ${ok} de ${changed}`)]);
    console.error("VERIFICAÇÃO FALHOU — ver results/errors.json");
    process.exit(1);
  }
}

main().catch((err) => {
  appendErrors([errorEntry("fatal", null, err?.message || String(err))]);
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
