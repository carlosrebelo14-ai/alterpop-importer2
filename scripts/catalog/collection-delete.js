#!/usr/bin/env node
/**
 * Apaga coleções por handle, uma a uma, com recheck. Usado na ENTREGA 2 · Tarefa 3
 * para remover `hello-kitty` (universo eliminado).
 *
 * DRY-RUN por defeito. `--execute` apaga. Passa um ou mais `--handle X`.
 *
 * Precisa de sessão OAuth offline (correr na Fly):
 *   node scripts/catalog/collection-delete.js --handle hello-kitty
 *   node scripts/catalog/collection-delete.js --handle hello-kitty --execute
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const HANDLES = args.reduce((acc, a, i) => {
  if (a === "--handle" && args[i + 1]) acc.push(args[i + 1]);
  return acc;
}, []);
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";

const FIND = `
  query CollFind($q: String!) {
    collections(first: 1, query: $q) {
      nodes { id handle title templateSuffix productsCount { count } }
    }
  }
`;
const DELETE = `
  mutation CollDelete($input: CollectionDeleteInput!) {
    collectionDelete(input: $input) { deletedCollectionId userErrors { field message } }
  }
`;

async function main() {
  if (!HANDLES.length) {
    console.error("passa pelo menos um --handle <handle>");
    process.exit(1);
  }
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  console.log(`=== collection-delete (${SHOP})${EXECUTE ? "" : " · DRY-RUN"} ===`);
  for (const handle of HANDLES) {
    const col = (await client.graphql(FIND, { q: `handle:${handle}` })).collections?.nodes?.[0];
    if (!col) {
      console.log(`  ${handle.padEnd(24)} — não existe (nada a fazer)`);
      continue;
    }
    console.log(`  ${handle.padEnd(24)} ${col.id}  ${col.productsCount?.count ?? "?"}p  tpl=${col.templateSuffix || "∅"}`);
    if (!EXECUTE) continue;

    const del = await client.graphql(DELETE, { input: { id: col.id } });
    const errs = del.collectionDelete?.userErrors || [];
    if (errs.length || !del.collectionDelete?.deletedCollectionId) {
      console.warn(`    ✗ ${errs.map((e) => e.message).join("; ") || "sem id devolvido"}`);
    } else {
      console.log(`    ✓ apagada`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!EXECUTE) console.log(`\nDRY-RUN — nada apagado. Corre com --execute.`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
