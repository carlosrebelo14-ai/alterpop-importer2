#!/usr/bin/env node
/**
 * Limpeza de coleções legacy — aprovada pelo Carlos a 2026-09-08.
 *
 * Apaga TODAS as coleções que NÃO são:
 *   - uma coleção Universe (templateSuffix === "universe-room")
 *   - `new-arrivals` (funcional, tag new-arrival)
 *
 * Ou seja: a família ociostock.licence (auto-licenca-* + loungefly/deportes/minnie/…),
 * as smart collections por TITLE/TAG (marvel-universe, dc-universe, best-sellers,
 * all-products, kawaii-lifestyle, premium-collectibles, wandavision, green-lantern,
 * trending-now) e as 3 manuais (jojos-bizarre-adventure, senhor-dos-aneis, ichibansho).
 *
 * DRY-RUN por defeito. `--execute` apaga. Antes de apagar valida, coleção a coleção,
 * que não tem templateSuffix universe-room — se a loja mudou entretanto, não apaga o
 * que não devia.
 *
 * Registar (renascem noutra fase, não aqui):
 *   - premium-collectibles → alterpop.tier EQUALS premium (quando o tier existir)
 *   - ichibansho → coleção Line, templateSuffix: line
 *
 * Precisa de sessão OAuth offline (correr na Fly).
 *   node scripts/catalog/collections-cleanup.js            # dry-run
 *   node scripts/catalog/collections-cleanup.js --execute
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
  process.env.SPOT_CHECK_SHOP ||
  "jyr17t-wr.myshopify.com";

/** Nunca apagar, mesmo que a regra abaixo os apanhasse por engano. */
const PROTECT_HANDLES = new Set(["new-arrivals"]);

const LIST_QUERY = `
  query CleanupList($cursor: String) {
    collections(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id handle title templateSuffix
        productsCount { count }
        ruleSet { rules { column condition } }
      }
    }
  }
`;

const DELETE_MUTATION = `
  mutation CleanupDelete($input: CollectionDeleteInput!) {
    collectionDelete(input: $input) { deletedCollectionId userErrors { field message } }
  }
`;

async function fetchAll(client) {
  const out = [];
  let cursor = null;
  for (let p = 0; p < 20; p++) {
    const data = await client.graphql(LIST_QUERY, { cursor });
    const conn = data?.collections;
    for (const n of conn?.nodes || []) out.push(n);
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}

async function main() {
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  const all = await fetchAll(client);
  const universe = all.filter((c) => c.templateSuffix === "universe-room");
  const toDelete = all.filter(
    (c) => c.templateSuffix !== "universe-room" && !PROTECT_HANDLES.has(c.handle)
  );

  console.log(`=== collections-cleanup (${SHOP})${EXECUTE ? "" : " · DRY-RUN"} ===`);
  console.log(`total ${all.length} · MANTER ${universe.length} Universe + ${all.length - universe.length - toDelete.length} protegidas · APAGAR ${toDelete.length}\n`);

  for (const c of toDelete.sort((a, b) => b.productsCount.count - a.productsCount.count)) {
    const rule = c.ruleSet === null ? "MANUAL" : (c.ruleSet.rules[0]?.column || "?");
    console.log(`  ${c.handle.padEnd(40)} ${String(c.productsCount.count).padStart(5)}p  ${rule}  [${c.id.split("/").pop()}]`);
  }

  if (!EXECUTE) {
    console.log(`\nDRY-RUN — nada apagado. Corre com --execute.`);
    return;
  }

  console.log(`\n=== a apagar ${toDelete.length} ===`);
  let ok = 0, failed = 0;
  for (const c of toDelete) {
    // Recheck defensivo mesmo aqui:
    if (c.templateSuffix === "universe-room" || PROTECT_HANDLES.has(c.handle)) continue;
    const res = await client.graphql(DELETE_MUTATION, { input: { id: c.id } });
    const errs = res.collectionDelete?.userErrors || [];
    if (errs.length || !res.collectionDelete?.deletedCollectionId) {
      failed++;
      console.warn(`  ✗ ${c.handle}: ${errs.map((e) => e.message).join("; ") || "sem id devolvido"}`);
    } else {
      ok++;
      console.log(`  ✓ ${c.handle}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`\napagadas: ${ok} · falhadas: ${failed}`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
