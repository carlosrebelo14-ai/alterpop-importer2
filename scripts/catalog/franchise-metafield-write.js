#!/usr/bin/env node
/**
 * Fase 6 — escreve `alterpop.franchise` nos produtos Shopify a partir do universo
 * resolvido pelo franchiseResolver.
 *
 * - Só produtos que RESOLVEM. Quem dá vazio não leva metafield (o tema distingue
 *   ausente de vazio, e ausente é o correto).
 * - Valor: array JSON de UM elemento — `["Star Wars"]` — porque a definição é
 *   `list.single_line_text_field`. Nome canónico da tabela dos 41.
 * - Idempotente: pula produtos que já têm o valor certo. Reescreve os que diferem.
 * - Por lotes de 25 (limite do metafieldsSet). `--limit` corta o total de ESCRITAS.
 * - `--dry-run` não escreve nada, só imprime o plano.
 * - `--universe "Harry Potter"` restringe a um universo (revisão faseada).
 *
 * Fonte da resolução: stream do feed OcioStock (OCIOSTOCK_CSV_URL / OCIOSTOCK_CSV_PATH)
 * → mapa SKU → universo. Cruzado com os produtos da loja pelo SKU da variante
 * (= `referencia` do feed).
 *
 * Uso (precisa de sessão OAuth offline em Prisma — correr na Fly ou local com .env):
 *   node scripts/catalog/franchise-metafield-write.js --dry-run --limit 300
 *   node scripts/catalog/franchise-metafield-write.js --limit 300
 *   node scripts/catalog/franchise-metafield-write.js --universe "The Lord of the Rings"
 *   node scripts/catalog/franchise-metafield-write.js            # tudo
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { streamOcioStockRows, mapOcioStockRow } from "../../lib/importer/connectors/ociostock/index.js";
import { resolveFranchise } from "../../lib/importer/catalog/franchiseResolver.server.js";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valOf = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const DRY_RUN = has("--dry-run");
const LIMIT = parseInt(valOf("--limit", "0"), 10) || 0;
const ONLY_UNIVERSE = valOf("--universe", "");
const SHOP =
  valOf("--shop", process.env.SPOT_CHECK_SHOP || process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com");

const NS = "alterpop";
const KEY = "franchise";
const TYPE = "list.single_line_text_field";
const CHUNK = 25;

const PRODUCTS_PAGE = `
  query FranchiseWritePage($cursor: String) {
    products(first: 100, after: $cursor, sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        variants(first: 1) { nodes { sku } }
        fr: metafield(namespace: "${NS}", key: "${KEY}") { value }
      }
    }
  }
`;

const METAFIELDS_SET = `
  mutation FranchiseWriteSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message code }
    }
  }
`;

/** @returns {Promise<Map<string, string>>} sku → nome do universo */
async function buildResolutionMap() {
  const map = new Map();
  await streamOcioStockRows({
    onRow: (row) => {
      const rec = mapOcioStockRow(row);
      if (!rec?.sku) return;
      const r = resolveFranchise(rec);
      if (r.franchise) map.set(rec.sku, r.franchise);
    },
  });
  return map;
}

async function main() {
  console.log(`=== franchise-metafield-write ===`);
  console.log(`shop ${SHOP}${DRY_RUN ? " · DRY-RUN" : ""}${LIMIT ? ` · limit ${LIMIT}` : ""}${ONLY_UNIVERSE ? ` · universo "${ONLY_UNIVERSE}"` : ""}`);

  const resolution = await buildResolutionMap();
  console.log(`mapa de resolução: ${resolution.size} SKUs do feed com universo`);

  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  const pending = []; // { ownerId, value }
  let scanned = 0, alreadyOk = 0, noResolve = 0, willWrite = 0, changed = 0;
  let cursor = null;

  outer: for (;;) {
    const data = await client.graphql(PRODUCTS_PAGE, { cursor });
    const conn = data.products;
    for (const p of conn.nodes) {
      scanned++;
      const sku = p.variants?.nodes?.[0]?.sku?.trim();
      const universe = sku ? resolution.get(sku) : null;
      if (!universe) { noResolve++; continue; }
      if (ONLY_UNIVERSE && universe !== ONLY_UNIVERSE) continue;

      const desired = JSON.stringify([universe]);
      if (p.fr?.value === desired) { alreadyOk++; continue; }
      if (p.fr?.value) changed++; // vai reescrever um valor diferente

      pending.push({ ownerId: p.id, namespace: NS, key: KEY, type: TYPE, value: desired });
      willWrite++;
      if (LIMIT && willWrite >= LIMIT) break outer;
    }
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  console.log(
    `\nprodutos vistos: ${scanned} · sem resolução: ${noResolve} · já corretos: ${alreadyOk} · a escrever: ${willWrite}` +
    (changed ? ` (dos quais ${changed} tinham valor diferente)` : "")
  );

  // distribuição por universo do que vai ser escrito
  const dist = {};
  for (const m of pending) {
    const u = JSON.parse(m.value)[0];
    dist[u] = (dist[u] || 0) + 1;
  }
  for (const [u, n] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${u}`);
  }

  if (DRY_RUN) { console.log("\nDRY-RUN — nada escrito."); return; }
  if (!pending.length) { console.log("\nNada a escrever."); return; }

  let ok = 0, failed = 0;
  for (let i = 0; i < pending.length; i += CHUNK) {
    const slice = pending.slice(i, i + CHUNK);
    const res = await client.graphql(METAFIELDS_SET, { metafields: slice });
    const errs = res.metafieldsSet?.userErrors || [];
    if (errs.length) {
      failed += slice.length;
      console.warn(`  lote ${i / CHUNK}: ${errs.length} erro(s) — ${errs.map((e) => e.message).join("; ")}`);
    } else {
      ok += res.metafieldsSet?.metafields?.length || 0;
    }
    await new Promise((r) => setTimeout(r, 350)); // respeita o rate limit
  }
  console.log(`\nescritos: ${ok} · falhados: ${failed}`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
