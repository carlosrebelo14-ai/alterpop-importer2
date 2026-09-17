/**
 * characterPagesSync — I/O partilhado entre o script manual
 * (scripts/catalog/character-pages-sync.js) e o ciclo automático do trigger-sync
 * (characterPagesReconcileCycle.server.js). A decisão fica em characterPages.server.js
 * (puro); aqui só se lê/escreve a loja e o Prisma.
 *
 * Escreve SÓ metaobjectUpsert (metaobject `character`) e metafieldsSet
 * (`alterpop.character` no produto, `alterpop.characters` na coleção) — nunca
 * `productUpdate` (secção 2 do arranque, 17/09/2026).
 */
import { prisma } from "../../prisma/prismaSafe.server.js";
import { getUniverseByName } from "../catalog/franchiseUniverses.js";
import { planUniverseCharacterCollections } from "../catalog/characterPages.server.js";
import { CHARACTER_METAOBJECT_TYPE } from "./characterMetaobjectSetup.js";

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
export async function fetchActiveProducts(client) {
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
export async function fetchExistingCharacters(client) {
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

/** @param {import('../shopifyClient.js').ShopifyClient} client
 *  @param {string} universoName
 *  @param {Map<string,string>} [cache] partilhado entre chamadas na mesma corrida */
export async function resolveCollectionGid(client, universoName, cache = new Map()) {
  if (cache.has(universoName)) return cache.get(universoName);
  const universe = getUniverseByName(universoName);
  if (!universe) throw new Error(`universo "${universoName}" não está em FRANCHISE_UNIVERSES`);
  const data = await client.graphql(COLLECTION_BY_HANDLE_QUERY, { handle: universe.handle });
  const gid = data?.collectionByHandle?.id || null;
  if (!gid) throw new Error(`coleção "${universe.handle}" (${universoName}) não encontrada na loja`);
  cache.set(universoName, gid);
  return gid;
}

/** Cruza os SKUs ACTIVE com resolvedCharacters/resolvedFranchise do Prisma.
 *  @param {string} shop
 *  @param {{ id: string, sku: string }[]} activeProducts */
export async function buildLiveCounts(shop, activeProducts) {
  const skus = activeProducts.map((p) => p.sku);
  const rows = skus.length
    ? await prisma.catalogProduct.findMany({
        where: { shop, sku: { in: skus } },
        select: { sku: true, resolvedCharacters: true, resolvedFranchise: true },
      })
    : [];
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

/**
 * Aplica um subconjunto de ações (create/reactivate/update/set-draft) à loja —
 * metaobjectUpsert + os metafieldsSet resultantes em produtos/coleções. Chamador decide
 * QUAIS ações entram aqui (travão do ciclo, ou todas no --execute manual).
 *
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {{
 *   actionsToApply: Array<{ handle: string, nome?: string, universo?: string, action: string, targetStatus?: string, count: number }>,
 *   liveCounts: Map<string, { universo: string, productIds: string[] }>,
 *   existing: Map<string, { id: string, status: string }>,
 *   activeProducts: { id: string, currentCharacterGids: string[] }[],
 *   collectionGidCache?: Map<string, string>,
 * }} args
 */
export async function applyCharacterActions(client, { actionsToApply, liveCounts, existing, activeProducts, collectionGidCache = new Map() }) {
  const resultingGidByHandle = new Map();
  const applied = [];
  /** @type {Map<string, { add: Set<string>, remove: Set<string> }>} productId -> refs a somar/tirar */
  const productDiffs = new Map();
  const touch = (productId, key, gid) => {
    if (!productDiffs.has(productId)) productDiffs.set(productId, { add: new Set(), remove: new Set() });
    productDiffs.get(productId)[key].add(gid);
  };

  for (const action of actionsToApply) {
    if (action.targetStatus === "ACTIVE") {
      const universeGid = await resolveCollectionGid(client, action.universo, collectionGidCache);
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
      applied.push({ ...action, gid });
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
      applied.push({ ...action, gid: ex.id });
    }
  }

  // alterpop.character por produto — um metafieldsSet por produto tocado, valor final =
  // (atual ∪ adições) \ remoções.
  const productById = new Map(activeProducts.map((p) => [p.id, p]));
  let productWrites = 0;
  for (const [productId, diff] of productDiffs) {
    const current = new Set(productById.get(productId)?.currentCharacterGids || []);
    for (const gid of diff.add) current.add(gid);
    for (const gid of diff.remove) current.delete(gid);
    const value = JSON.stringify([...current]);
    const data = await client.graphql(METAFIELDS_SET, {
      metafields: [{ ownerId: productId, namespace: NAMESPACE, key: "character", type: "list.metaobject_reference", value }],
    });
    const setErrors = data.metafieldsSet?.userErrors || [];
    if (setErrors.length) throw new Error(`metafieldsSet(${productId}, alterpop.character): ${setErrors.map((e) => e.message).join("; ")}`);
    productWrites += 1;
  }

  // alterpop.characters por coleção — recalcula para todos os universos tocados pelas
  // ações aplicadas (mesmo os que ficam sem nenhum Character ACTIVE: valor final = []).
  const universosTocados = new Set(applied.filter((a) => a.universo).map((a) => a.universo));
  const collectionsPlan = planUniverseCharacterCollections(applied);
  let collectionWrites = 0;
  const collectionsWritten = [];
  for (const universo of universosTocados) {
    const handles = collectionsPlan.get(universo) || [];
    const gids = handles.map((h) => resultingGidByHandle.get(h)).filter(Boolean);
    const collectionGid = await resolveCollectionGid(client, universo, collectionGidCache);
    const data = await client.graphql(METAFIELDS_SET, {
      metafields: [{ ownerId: collectionGid, namespace: NAMESPACE, key: "characters", type: "list.metaobject_reference", value: JSON.stringify(gids) }],
    });
    const setErrors = data.metafieldsSet?.userErrors || [];
    if (setErrors.length) throw new Error(`metafieldsSet(${collectionGid}, alterpop.characters): ${setErrors.map((e) => e.message).join("; ")}`);
    collectionWrites += 1;
    collectionsWritten.push({ universo, handles });
  }

  return { applied, resultingGidByHandle, productWrites, collectionWrites, collectionsWritten };
}
