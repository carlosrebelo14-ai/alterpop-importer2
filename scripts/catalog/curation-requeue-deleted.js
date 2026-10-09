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
 * Alvo explícito, sem omissão: `--to approved` (o ciclo seguinte cria-os de novo, já com
 * o preço da regra) ou `--to pending` (voltam à curadoria para nova decisão).
 * Recusa escrever com uma indexação a correr — o worker trabalha sobre uma cópia da fila
 * e repunha PUBLISHED no flush.
 *
 * DRY-RUN por omissão. Escreve só com --execute. Erros → results/errors.json.
 * Correr na Fly:
 *   node scripts/catalog/curation-requeue-deleted.js
 *   node scripts/catalog/curation-requeue-deleted.js --execute --to approved
 */
import fs from "node:fs";
import path from "node:path";
import { loadCurationQueue, saveCurationQueue } from "../../lib/curation/curationQueue.server.js";
import { readCatalogRebuildStatus } from "../../lib/importer/catalog/catalogRebuildStatus.server.js";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { fetchLiveVariantsBySku } from "../../lib/importer/shopify/liveVariantsBySku.server.js";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const toArg = args.indexOf("--to") >= 0 ? String(args[args.indexOf("--to") + 1] || "").toUpperCase() : null;
const TARGET = toArg === "APPROVED" || toArg === "PENDING" ? toArg : null;
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
  if (EXECUTE && !TARGET) {
    console.error("PARADO: --execute precisa de --to approved ou --to pending.");
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
    console.log(`  node scripts/catalog/curation-requeue-deleted.js --execute --to approved   # o ciclo cria-os de novo`);
    console.log(`  node scripts/catalog/curation-requeue-deleted.js --execute --to pending    # voltam à curadoria`);
    return;
  }

  if (await indexingRunning()) {
    errors.push(errorEntry("indexing_running", null, "indexação a correr — nada escrito"));
    appendErrors(errors);
    console.error("\nPARADO: indexação a correr (o worker repunha PUBLISHED). Espera que termine e corre de novo.");
    process.exit(1);
  }

  // Carrega a fila de novo imediatamente antes de gravar; só muda os confirmados que
  // continuam PUBLISHED com o mesmo shopifyProductId.
  const queue = await loadCurationQueue();
  const bySku = new Map(deleted.map((d) => [d.sku, d.pid]));
  const now = new Date().toISOString();
  let changed = 0;
  for (const item of queue.items) {
    const pid = bySku.get(item.sku);
    if (!pid || item.status !== "PUBLISHED" || item.metadata?.shopifyProductId !== pid) continue;
    item.status = TARGET;
    item.shopifyStatus = "ACTIVE";
    item.metadata = {
      ...item.metadata,
      shopifyProductId: null,
      publishedAt: null,
      previousShopifyProductId: pid,
      // Sem approvedAt o V3 não conta a idade e um APPROVED parado nunca fica vermelho.
      approvedAt: TARGET === "APPROVED" ? now : item.metadata?.approvedAt ?? null,
      shopifyResetAt: now,
      shopifyResetReason: "deleted_in_shopify_admin",
      syncError: null,
      syncErrorAt: null,
    };
    changed += 1;
  }
  if (changed !== deleted.length) {
    errors.push(
      errorEntry("queue_changed_since_read", null, `${deleted.length - changed} item(s) mudaram na fila entre a leitura e a escrita — não tocados`)
    );
  }
  if (changed > 0) await saveCurationQueue(queue);
  appendErrors(errors);

  const after = (await loadCurationQueue()).items;
  const ok = after.filter((i) => bySku.has(i.sku) && i.status === TARGET && i.metadata?.shopifyProductId == null).length;
  console.log(`\nescritos: ${changed} → ${TARGET} · verificados na fila: ${ok}`);
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
