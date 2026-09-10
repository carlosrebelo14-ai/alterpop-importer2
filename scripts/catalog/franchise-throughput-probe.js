#!/usr/bin/env node
/**
 * ENTREGA 2 · Tarefa 8 — throughput de escrita de metafields.
 *
 * Cria N produtos DESCARTÁVEIS (default 50, título `zzz-throughput-probe-*`, DRAFT),
 * escreve `alterpop.franchise = ["Star Wars"]` em todos via metafieldsSet em lotes de
 * 25, mede os tempos, e apaga tudo no fim.
 *
 * Confirma:
 *   - metafieldsSet aceita 25 por chamada (limite documentado)
 *   - o backoff a THROTTLED do shopifyClient funciona (conta client.stats)
 *   - ritmo real → extrapolação para o catálogo publicado (~2,5k) e resolvido (~12,7k)
 *
 * Read-mostly: os produtos-teste são removidos no fim (--keep para inspecionar).
 *
 * Precisa de sessão OAuth offline (correr na Fly):
 *   node scripts/catalog/franchise-throughput-probe.js
 *   node scripts/catalog/franchise-throughput-probe.js --n 50 --keep
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";

const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const N = (() => {
  const i = args.indexOf("--n");
  return i >= 0 && args[i + 1] ? Math.max(1, parseInt(args[i + 1], 10) || 50) : 50;
})();
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";

const PRODUCT_CREATE = `
  mutation ProbeCreate($input: ProductInput!) {
    productCreate(input: $input) { product { id } userErrors { field message } }
  }
`;
const METAFIELDS_SET = `
  mutation ProbeMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message } }
  }
`;
const PRODUCT_DELETE = `
  mutation ProbeDelete($input: ProductDeleteInput!) {
    productDelete(input: $input) { deletedProductId userErrors { field message } }
  }
`;

const ms = () => Date.now();
const fmt = (n) => `${(n / 1000).toFixed(1)}s`;

async function main() {
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);
  const stamp = Date.now();

  console.log(`=== franchise-throughput-probe (${SHOP}) · N=${N} ===`);

  // 1. criar
  const t0 = ms();
  const ids = [];
  for (let i = 0; i < N; i++) {
    const res = await client.graphql(PRODUCT_CREATE, {
      input: { title: `zzz-throughput-probe-${stamp}-${i}`, status: "DRAFT" },
    });
    const errs = res.productCreate?.userErrors || [];
    if (errs.length || !res.productCreate?.product?.id) {
      console.warn(`  create ${i} falhou: ${errs.map((e) => e.message).join("; ")}`);
      continue;
    }
    ids.push(res.productCreate.product.id);
  }
  const tCreate = ms() - t0;
  console.log(`criar ${ids.length} produtos: ${fmt(tCreate)}  (${(tCreate / ids.length).toFixed(0)} ms/produto)`);

  // 2. escrever metafield em lotes de 25
  const t1 = ms();
  let written = 0;
  let batches = 0;
  for (let i = 0; i < ids.length; i += 25) {
    const slice = ids.slice(i, i + 25);
    const res = await client.graphql(METAFIELDS_SET, {
      metafields: slice.map((id) => ({
        ownerId: id,
        namespace: "alterpop",
        key: "franchise",
        type: "list.single_line_text_field",
        value: JSON.stringify(["Star Wars"]),
      })),
    });
    const errs = res.metafieldsSet?.userErrors || [];
    if (errs.length) console.warn(`  batch ${batches} userErrors: ${errs.map((e) => e.message).join("; ")}`);
    written += res.metafieldsSet?.metafields?.length || 0;
    batches += 1;
  }
  const tWrite = ms() - t1;
  console.log(`escrever ${written} metafields em ${batches} lote(s) de 25: ${fmt(tWrite)}  (${(tWrite / Math.max(written, 1)).toFixed(0)} ms/metafield)`);

  // 3. stats de throttle
  console.log(`\nclient.stats: ${JSON.stringify(client.stats)}`);
  const perMf = tWrite / Math.max(written, 1);
  console.log(`\nextrapolação (só a fase metafieldsSet, ${perMf.toFixed(0)} ms/mf):`);
  console.log(`  ~2.500 publicados : ${fmt(perMf * 2500)}`);
  console.log(`  ~12.700 resolvidos: ${fmt(perMf * 12700)}`);
  console.log(`(o ciclo real corre num IIFE destacado no trigger-sync, sem timeout de HTTP;`);
  console.log(` INDEXING_TIMEOUT_MS=40min só cobre a fase de indexação, não o publish.)`);

  // 4. limpar
  if (KEEP) {
    console.log(`\n--keep: ${ids.length} produtos-teste deixados na loja (handle zzz-throughput-probe-${stamp}-*).`);
    return;
  }
  const t2 = ms();
  let deleted = 0;
  for (const id of ids) {
    const res = await client.graphql(PRODUCT_DELETE, { input: { id } });
    if (res.productDelete?.deletedProductId) deleted += 1;
    await new Promise((r) => setTimeout(r, 80));
  }
  console.log(`\napagados ${deleted}/${ids.length} produtos-teste: ${fmt(ms() - t2)}`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
