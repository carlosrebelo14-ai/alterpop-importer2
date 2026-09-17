#!/usr/bin/env node
/**
 * B7 (briefing backend, 17/09/2026) — character-pages-sync.js, secção 6/8 passo 5-6.
 *
 * Aplica characterPages.server.js (puro) ao estado real da loja: lê os SKUs ACTIVE
 * (Online Store), cruza com `resolvedCharacters`/`resolvedFranchise` do Prisma, lê os
 * metaobjects `character` já existentes, e decide create/reactivate/update/set-draft/skip
 * por handle — nunca apaga um metaobject, nunca trunca `products` acima de 128.
 *
 * DRY-RUN por defeito: só relata as ações previstas. `--execute` escreve:
 *  - metaobjectUpsert (create/reactivate/update/set-draft) — NUNCA productUpdate.
 *  - `alterpop.character` nos produtos afetados (metafieldsSet), só para handles ACTIVE.
 *  - `alterpop.characters` nas coleções Universe tocadas (metafieldsSet), ACTIVE do
 *    universo, do maior para o menor número de produtos.
 *
 * Correr na Fly:  node scripts/catalog/character-pages-sync.js
 *                 node scripts/catalog/character-pages-sync.js --execute
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import {
  planCharacterMetaobjects,
  planUniverseCharacterCollections,
  CHARACTER_PRODUCTS_MAX,
} from "../../lib/importer/catalog/characterPages.server.js";
import { getUniverseByName } from "../../lib/importer/catalog/franchiseUniverses.js";
import { CHARACTER_METAOBJECT_TYPE } from "../../lib/importer/shopify/characterMetaobjectSetup.js";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
const NAMESPACE = "alterpop";

const ACTIVE_PRODUCTS_QUERY = `
  query CharacterPagesActive($cursor: String) {
    products(first: 250, after: $cursor, query: "status:active") {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        variants(first: 1) { nodes { sku } }
        characterField: metafield(namespace: "alterpop", key: "character") { value }
      }
    }
  }
`;

const EXISTING_METAOBJECTS_QUERY = `
  query CharacterMetaobjects($cursor: String) {
    metaobjects(type: "${CHARACTER_METAOBJECT_TYPE}", first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        capabilities { publishable { status } }
      }
    }
  }
`;

const COLLECTION_BY_HANDLE_QUERY = `
  query CharacterPagesCollection($handle: String!) {
    collectionByHandle(handle: $handle) {
      id
    }
  }
`;

const METAOBJECT_UPSERT = `
  mutation CharacterMetaobjectUpsert($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
    metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
      metaobject { id handle capabilities { publishable { status } } }
      userErrors { field message code }
    }
  }
`;

const METAFIELDS_SET = `
  mutation CharacterPagesMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message code }
    }
  }
`;

/** Produtos ACTIVE (Online Store), com o valor atual de alterpop.character. */
async function fetchActiveProducts(client) {
  const products = [];
  let cursor = null;
  for (;;) {
    const data = await client.graphql(ACTIVE_PRODUCTS_QUERY, { cursor });
    const conn = data?.products;
    for (const n of conn?.nodes || []) {
      const sku = n.variants?.nodes?.[0]?.sku || null;
      if (!sku) continue;
      let currentGids = [];
      try {
        currentGids = JSON.parse(n.characterField?.value || "[]");
      } catch {
        currentGids = [];
      }
      products.push({ id: n.id, sku, currentCharacterGids: currentGids });
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return products;
}

/** Metaobjects `character` já existentes na loja. */
async function fetchExistingCharacters(client) {
  const existing = new Map();
  let cursor = null;
  for (;;) {
    const data = await client.graphql(EXISTING_METAOBJECTS_QUERY, { cursor });
    const conn = data?.metaobjects;
    for (const n of conn?.nodes || []) {
      existing.set(n.handle, { id: n.id, status: n.capabilities?.publishable?.status || "DRAFT" });
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return existing;
}

const collectionGidCache = new Map();
async function resolveCollectionGid(client, universoName) {
  if (collectionGidCache.has(universoName)) return collectionGidCache.get(universoName);
  const universe = getUniverseByName(universoName);
  if (!universe) throw new Error(`universo "${universoName}" não está em FRANCHISE_UNIVERSES`);
  const data = await client.graphql(COLLECTION_BY_HANDLE_QUERY, { handle: universe.handle });
  const gid = data?.collectionByHandle?.id || null;
  if (!gid) throw new Error(`coleção "${universe.handle}" (${universoName}) não encontrada na loja`);
  collectionGidCache.set(universoName, gid);
  return gid;
}

/** Cruza os SKUs ACTIVE com resolvedCharacters/resolvedFranchise do Prisma. */
async function buildLiveCounts(activeProducts) {
  const skus = activeProducts.map((p) => p.sku);
  const rows = await prisma.catalogProduct.findMany({
    where: { shop: SHOP, sku: { in: skus } },
    select: { sku: true, resolvedCharacters: true, resolvedFranchise: true },
  });
  const bySku = new Map(rows.map((r) => [r.sku, r]));

  /** @type {Map<string, { universo: string, productSkus: string[], productIds: string[] }>} */
  const liveCounts = new Map();
  for (const p of activeProducts) {
    const row = bySku.get(p.sku);
    if (!row?.resolvedCharacters || !row.resolvedFranchise) continue;
    let handles = [];
    try {
      handles = JSON.parse(row.resolvedCharacters);
    } catch {
      continue;
    }
    for (const handle of handles) {
      if (!liveCounts.has(handle)) liveCounts.set(handle, { universo: row.resolvedFranchise, productSkus: [], productIds: [] });
      const entry = liveCounts.get(handle);
      entry.productSkus.push(p.sku);
      entry.productIds.push(p.id);
    }
  }
  return liveCounts;
}

function reportActions(actions) {
  console.log(`\n── ações previstas (${actions.length} handles) ──`);
  const relevant = actions.filter((a) => a.action !== "skip");
  if (!relevant.length) {
    console.log(`  (nenhuma — tudo skip)`);
  }
  for (const a of relevant) {
    const linha = `  ${a.action.padEnd(10)} ${a.handle.padEnd(20)} ${(a.universo || "∅").padEnd(14)} ${String(a.count).padStart(4)} produtos`;
    if (a.action === "error") {
      console.log(`${linha}  ⚠ ${a.error}`);
    } else {
      console.log(linha);
    }
  }
  const skipped = actions.filter((a) => a.action === "skip");
  console.log(`\n  skip (nunca teve metaobject, abaixo do limiar): ${skipped.length} handles`);
}

function reportCollectionsPlan(plan) {
  console.log(`\n── alterpop.characters previsto por universo ──`);
  if (!plan.size) {
    console.log(`  (nenhum universo com Character ACTIVE)`);
    return;
  }
  for (const [universo, handles] of plan) {
    console.log(`  ${universo}: [${handles.join(", ")}]`);
  }
}

async function dryRun() {
  console.log(`\n=== character-pages-sync (${SHOP}) · DRY-RUN ===\n`);

  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  const activeProducts = await fetchActiveProducts(client);
  console.log(`produtos ACTIVE na loja: ${activeProducts.length}`);

  const existing = await fetchExistingCharacters(client);
  console.log(`metaobjects "character" já existentes: ${existing.size}`);

  const liveCounts = await buildLiveCounts(activeProducts);
  const actions = planCharacterMetaobjects({ liveCounts, existing });
  reportActions(actions);

  const collectionsPlan = planUniverseCharacterCollections(actions);
  reportCollectionsPlan(collectionsPlan);

  const errors = actions.filter((a) => a.action === "error");
  console.log(`\n(nada escrito — dry-run.)`);
  if (errors.length) {
    throw new Error(`${errors.length} handle(s) acima do limite de ${CHARACTER_PRODUCTS_MAX} produtos — ver acima`);
  }
}

async function execute() {
  console.log(`\n=== character-pages-sync (${SHOP}) · --execute ===\n`);

  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  const activeProducts = await fetchActiveProducts(client);
  const productById = new Map(activeProducts.map((p) => [p.id, p]));
  const existing = await fetchExistingCharacters(client);
  const liveCounts = await buildLiveCounts(activeProducts);
  const actions = planCharacterMetaobjects({ liveCounts, existing });
  reportActions(actions);

  const errors = actions.filter((a) => a.action === "error");
  if (errors.length) {
    throw new Error(`${errors.length} handle(s) acima do limite de ${CHARACTER_PRODUCTS_MAX} produtos — corrigido à mão antes de --execute`);
  }

  const resultingGidByHandle = new Map();
  /** @type {Map<string, { add: Set<string>, remove: Set<string> }>} productId -> refs a somar/tirar */
  const productDiffs = new Map();
  const touch = (productId, key, gid) => {
    if (!productDiffs.has(productId)) productDiffs.set(productId, { add: new Set(), remove: new Set() });
    productDiffs.get(productId)[key].add(gid);
  };

  for (const action of actions) {
    if (action.action === "skip" || action.action === "error") continue;

    if (action.targetStatus === "ACTIVE") {
      const universeGid = await resolveCollectionGid(client, action.universo);
      const productIds = liveCounts.get(action.handle).productIds;
      const data = await client.graphql(METAOBJECT_UPSERT, {
        handle: { type: CHARACTER_METAOBJECT_TYPE, handle: action.handle },
        metaobject: {
          capabilities: { publishable: { status: "ACTIVE" } },
          fields: [
            { key: "title", value: action.nome },
            { key: "universe", value: JSON.stringify([universeGid]) },
            { key: "products", value: JSON.stringify(productIds) },
          ],
        },
      });
      const upsertErrors = data.metaobjectUpsert?.userErrors || [];
      if (upsertErrors.length) throw new Error(`metaobjectUpsert(${action.handle}): ${upsertErrors.map((e) => e.message).join("; ")}`);
      const gid = data.metaobjectUpsert.metaobject.id;
      resultingGidByHandle.set(action.handle, gid);
      for (const pid of productIds) touch(pid, "add", gid);
      console.log(`  ${action.action.padEnd(10)} ${action.handle}  →  ${gid}  (${productIds.length} produtos)`);
      continue;
    }

    if (action.action === "set-draft") {
      const ex = existing.get(action.handle);
      const data = await client.graphql(METAOBJECT_UPSERT, {
        handle: { type: CHARACTER_METAOBJECT_TYPE, handle: action.handle },
        metaobject: { capabilities: { publishable: { status: "DRAFT" } } },
      });
      const upsertErrors = data.metaobjectUpsert?.userErrors || [];
      if (upsertErrors.length) throw new Error(`metaobjectUpsert(${action.handle}): ${upsertErrors.map((e) => e.message).join("; ")}`);
      // Remove a referência de todos os produtos ACTIVE que hoje apontam para este GID —
      // "products" do metaobject fica intocado (secção 6), só a referência sai do produto.
      for (const p of activeProducts) {
        if (p.currentCharacterGids.includes(ex.id)) touch(p.id, "remove", ex.id);
      }
      console.log(`  ${action.action.padEnd(10)} ${action.handle}  →  DRAFT (referências removidas dos produtos)`);
    }
  }

  // alterpop.character por produto — um metafieldsSet por produto tocado, valor final =
  // (atual ∪ adições) \ remoções.
  let productWrites = 0;
  for (const [productId, diff] of productDiffs) {
    const current = new Set(productById.get(productId)?.currentCharacterGids || []);
    for (const gid of diff.add) current.add(gid);
    for (const gid of diff.remove) current.delete(gid);
    const value = JSON.stringify([...current]);
    const data = await client.graphql(METAFIELDS_SET, {
      metafields: [
        { ownerId: productId, namespace: NAMESPACE, key: "character", type: "list.metaobject_reference", value },
      ],
    });
    const setErrors = data.metafieldsSet?.userErrors || [];
    if (setErrors.length) throw new Error(`metafieldsSet(${productId}, alterpop.character): ${setErrors.map((e) => e.message).join("; ")}`);
    productWrites += 1;
  }
  console.log(`\nalterpop.character escrito em ${productWrites} produto(s)`);

  // alterpop.characters por coleção — recalcula para TODOS os universos tocados por
  // alguma ação (mesmo os que ficam sem nenhum Character ACTIVE: valor final = []).
  const universosTocados = new Set(actions.filter((a) => a.universo && a.action !== "skip" && a.action !== "error").map((a) => a.universo));
  const collectionsPlan = planUniverseCharacterCollections(actions);
  let collectionWrites = 0;
  for (const universo of universosTocados) {
    const handles = collectionsPlan.get(universo) || [];
    const gids = handles.map((h) => resultingGidByHandle.get(h)).filter(Boolean);
    const collectionGid = await resolveCollectionGid(client, universo);
    const data = await client.graphql(METAFIELDS_SET, {
      metafields: [
        { ownerId: collectionGid, namespace: NAMESPACE, key: "characters", type: "list.metaobject_reference", value: JSON.stringify(gids) },
      ],
    });
    const setErrors = data.metafieldsSet?.userErrors || [];
    if (setErrors.length) throw new Error(`metafieldsSet(${collectionGid}, alterpop.characters): ${setErrors.map((e) => e.message).join("; ")}`);
    console.log(`  alterpop.characters(${universo}) = [${handles.join(", ")}]`);
    collectionWrites += 1;
  }
  console.log(`\nalterpop.characters escrito em ${collectionWrites} coleção/coleções`);
}

async function main() {
  if (EXECUTE) await execute();
  else await dryRun();
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
