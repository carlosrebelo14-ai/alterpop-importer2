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
import { getUniverseByName, getUniverseByHandle } from "../catalog/franchiseUniverses.js";
import { planUniverseCharacterCollections, planCharacterMetaobjects } from "../catalog/characterPages.server.js";
import { CHARACTER_METAOBJECT_TYPE } from "./characterMetaobjectSetup.js";

const NAMESPACE = "alterpop";
/** "Products can't be blank" (a Shopify traduz o nome do campo, a frase fica em inglês). */

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
        fields { key value }
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
      existing.set(n.handle, {
        id: n.id,
        status: n.capabilities?.publishable?.status || "DRAFT",
        fields: new Map((n.fields || []).map((f) => [f.key, f.value])),
      });
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return existing;
}

/** Lista JSON de gids ou ids; valor antigo que não seja lista conta como vazio. */
function listaJson(valor) {
  try {
    const v = JSON.parse(valor ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Campo igual: listas comparam como conjuntos (ordem da loja não é mudança), o resto como string. */
function campoIgual(key, antes, value) {
  if (key === "universe" || key === "products") {
    return JSON.stringify(conjuntoJson(antes)) === JSON.stringify(conjuntoJson(value));
  }
  return antes === value;
}

/** Conjunto ordenado de gids; valor antigo inválido conta como vazio. */
function conjuntoJson(valor) {
  return [...new Set(listaJson(valor))].sort();
}

/**
 * Puro (29/10/2026): true se um update não muda nenhum campo que o ciclo escreve.
 * Metaobject sem campos (prevFields undefined) nunca é igual.
 * @param {Map<string, string>|undefined} prevFields
 * @param {Array<{ key: string, value: string }>} nextFields
 * @returns {boolean}
 */
export function updateSemMudanca(prevFields, nextFields) {
  if (!prevFields) return false;
  return nextFields.every(({ key, value }) => campoIgual(key, prevFields.get(key) ?? null, value));
}

/**
 * Puro (29/10/2026): troca "update" por "noop" quando nada muda. Sem isto o census e o ciclo
 * contam como update todo Character ACTIVE acima do limiar, mesmo sem diferença na loja.
 * @param {Array<object>} actions plano de planCharacterMetaobjects
 * @param {Map<string, { fields: Map<string, string> }>} existing
 * @param {Map<string, { productIds: string[] }>} liveCounts
 * @param {Map<string, string>} universeGidByName nome do universo -> gid da coleção
 * @returns {Array<object>}
 */
export function marcarUpdatesSemMudanca(actions, existing, liveCounts, universeGidByName) {
  return actions.map((a) => {
    if (a.action !== "update") return a;
    const nextFields = [
      { key: "title", value: a.nome },
      { key: "universe", value: JSON.stringify((a.universos || []).map((u) => universeGidByName.get(u))) },
      { key: "products", value: JSON.stringify(liveCounts.get(a.handle)?.productIds ?? []) },
    ];
    return updateSemMudanca(existing.get(a.handle)?.fields, nextFields) ? { ...a, action: "noop" } : a;
  });
}

/**
 * Resolve o gid de cada universo que aparece num update do plano (uma chamada por universo).
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {Array<object>} actions
 * @param {Map<string,string>} [cache]
 * @returns {Promise<Map<string, string>>}
 */
export async function resolverUniversosDosUpdates(client, actions, cache = new Map()) {
  const porNome = new Map();
  for (const a of actions) {
    if (a.action !== "update") continue;
    for (const universo of a.universos || []) {
      if (!porNome.has(universo)) porNome.set(universo, await resolveCollectionGid(client, universo, cache));
    }
  }
  return porNome;
}

/**
 * Puro (28/10/2026): linhas de log com o valor anterior de cada campo que o ciclo escreve.
 * Listas JSON (universe, products) saem com o diff de gids: +adicionados -removidos.
 * @param {string} handle
 * @param {Map<string, string>|undefined} prevFields campos atuais do metaobject (undefined = não existe)
 * @param {Array<{ key: string, value: string }>} nextFields campos que vão ser escritos
 * @returns {string[]}
 */
export function diffCharacterFieldLines(handle, prevFields, nextFields) {
  const lines = [];
  if (!prevFields) {
    lines.push(`  ${handle} · metaobject novo`);
  }
  for (const { key, value } of nextFields) {
    const antes = prevFields?.get(key) ?? null;
    if (campoIgual(key, antes, value)) continue;
    const linha = `  ${handle} · ${key}: antes=${antes ?? "(vazio)"} · depois=${value}`;
    if (key === "universe" || key === "products") {
      const prevList = listaJson(antes);
      const nextList = listaJson(value);
      const added = nextList.filter((x) => !prevList.includes(x));
      const removed = prevList.filter((x) => !nextList.includes(x));
      lines.push(`${linha} · +${added.length} -${removed.length}`);
    } else {
      lines.push(linha);
    }
  }
  return lines;
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

/**
 * Puro (PR 4b, 28/10/2026): a partir das ligações ProductCharacter e da franquia de cada SKU,
 * calcula por handle quantos produtos ACTIVE o publicam e em que universos. Um personagem tem
 * universos = união dos universeHandle das suas ligações (fallback: a franquia do SKU).
 * @param {{ id: string, sku: string }[]} activeProducts
 * @param {Map<string, Array<{ handle: string, universeHandle?: string|null }>>} linksBySku
 * @param {Map<string, string>} franchiseBySku  sku -> resolvedFranchise
 * @returns {Map<string, { universo: string, universos: string[], productSkus: string[], productIds: string[] }>}
 */
export function liveCountsFromLinks(activeProducts, linksBySku, franchiseBySku) {
  /** @type {Map<string, { universo: string, universos: string[], productSkus: string[], productIds: string[] }>} */
  const liveCounts = new Map();
  for (const p of activeProducts) {
    const franquia = franchiseBySku.get(p.sku);
    for (const link of linksBySku.get(p.sku) || []) {
      const universoLink = (link.universeHandle && getUniverseByHandle(link.universeHandle)?.name) || franquia;
      if (!universoLink) continue;
      if (!liveCounts.has(link.handle)) liveCounts.set(link.handle, { universo: universoLink, universos: [], productSkus: [], productIds: [] });
      const entry = liveCounts.get(link.handle);
      if (!entry.universos.includes(universoLink)) entry.universos.push(universoLink);
      entry.productSkus.push(p.sku);
      entry.productIds.push(p.id);
    }
  }
  return liveCounts;
}

/** Lê ProductCharacter (fonte do ciclo desde o PR 4b) e a franquia de cada SKU ACTIVE.
 *  @param {string} shop
 *  @param {{ id: string, sku: string }[]} activeProducts */
export async function buildLiveCounts(shop, activeProducts) {
  const skus = activeProducts.map((p) => p.sku);
  if (!skus.length) return new Map();
  const [links, products] = await Promise.all([
    prisma.productCharacter.findMany({
      where: { shop, sku: { in: skus } },
      select: { sku: true, characterHandle: true, universeHandle: true },
    }),
    prisma.catalogProduct.findMany({
      where: { shop, sku: { in: skus } },
      select: { sku: true, resolvedFranchise: true },
    }),
  ]);
  const linksBySku = new Map();
  for (const l of links) {
    if (!linksBySku.has(l.sku)) linksBySku.set(l.sku, []);
    linksBySku.get(l.sku).push({ handle: l.characterHandle, universeHandle: l.universeHandle });
  }
  const franchiseBySku = new Map(products.filter((r) => r.resolvedFranchise).map((r) => [r.sku, r.resolvedFranchise]));
  return liveCountsFromLinks(activeProducts, linksBySku, franchiseBySku);
}

/**
 * Puro (29/10/2026): um product-update por produto cujo alterpop.character não bate com o que
 * ProductCharacter pede. Pedido = handles com ação ACTIVE cujo liveCounts inclui o produto.
 * Corrige o caso yoda -> grogu: o metaobject já tinha o produto fora, mas o produto ficou com a etiqueta velha.
 * @param {Array<{ handle: string, action: string, targetStatus?: string }>} actions plano de personagens
 * @param {Map<string, { productIds: string[] }>} liveCounts
 * @param {{ id: string, sku: string, currentCharacterGids: string[] }[]} activeProducts
 * @param {Map<string, { id: string }>} existing
 * @returns {object[]}
 */
export function planProductCharacterUpdates(actions, liveCounts, activeProducts, existing) {
  const pedidoPorProduto = new Map();
  for (const a of actions) {
    if (a.targetStatus !== "ACTIVE") continue;
    for (const pid of liveCounts.get(a.handle)?.productIds ?? []) {
      if (!pedidoPorProduto.has(pid)) pedidoPorProduto.set(pid, new Set());
      pedidoPorProduto.get(pid).add(a.handle);
    }
  }
  const handleByGid = new Map([...existing].map(([handle, ex]) => [ex.id, handle]));
  const out = [];
  for (const p of activeProducts) {
    const pedido = pedidoPorProduto.get(p.id) ?? new Set();
    // gid sem metaobject conhecido conta como divergência: nunca bate com um handle pedido.
    const atual = new Set(p.currentCharacterGids.map((gid) => handleByGid.get(gid) ?? `?${gid}`));
    const igual = atual.size === pedido.size && [...pedido].every((h) => atual.has(h));
    if (igual) continue;
    out.push({ action: "product-update", handle: p.sku, sku: p.sku, productId: p.id, handles: [...pedido].sort(), targetStatus: undefined });
  }
  return out;
}

/**
 * Plano completo de uma corrida: personagens (com noop) + product-update. Usado pelo census,
 * pelo cycle-apply-once e pelo ciclo, para que a trava conte os dois juntos.
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {{ activeProducts: object[], existing: Map<string, object>, liveCounts: Map<string, object> }} args
 */
export async function planearCicloCompleto(client, { activeProducts, existing, liveCounts }) {
  const planned = planCharacterMetaobjects({ liveCounts, existing });
  const universeGidByName = await resolverUniversosDosUpdates(client, planned);
  const semNoop = marcarUpdatesSemMudanca(planned, existing, liveCounts, universeGidByName);
  return [...semNoop, ...planProductCharacterUpdates(semNoop, liveCounts, activeProducts, existing)];
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
export async function applyCharacterActions(client, { actionsToApply, liveCounts, existing, collectionGidCache = new Map() }) {
  const resultingGidByHandle = new Map();
  const applied = [];
  for (const action of actionsToApply) {
    if (action.targetStatus === "ACTIVE") {
      const universeGids = [];
      for (const universo of action.universos || []) {
        universeGids.push(await resolveCollectionGid(client, universo, collectionGidCache));
      }
      const productIds = liveCounts.get(action.handle).productIds;
      const nextFields = [
        { key: "title", value: action.nome },
        { key: "universe", value: JSON.stringify(universeGids) },
        { key: "products", value: JSON.stringify(productIds) },
      ];
      const ex = existing?.get(action.handle);
      for (const linha of diffCharacterFieldLines(action.handle, ex?.fields, nextFields)) console.log(linha);
      const data = await client.graphql(METAOBJECT_UPSERT, {
        handle: { type: CHARACTER_METAOBJECT_TYPE, handle: action.handle },
        metaobject: {
          capabilities: { publishable: { status: "ACTIVE" } },
          fields: nextFields,
        },
      });
      const upsertErrors = data.metaobjectUpsert?.userErrors || [];
      if (upsertErrors.length) throw new Error(`metaobjectUpsert(${action.handle}): ${upsertErrors.map((e) => e.message).join("; ")}`);
      const gid = data.metaobjectUpsert.metaobject.id;
      resultingGidByHandle.set(action.handle, gid);
      applied.push({ ...action, gid });
      continue;
    }

    if (action.action === "set-draft") {
      const ex = existing.get(action.handle);
      console.log(`  ${action.handle} · status: antes=${ex.status} · depois=DRAFT`);
      const data = await client.graphql(METAOBJECT_UPSERT, {
        handle: { type: CHARACTER_METAOBJECT_TYPE, handle: action.handle },
        metaobject: { capabilities: { publishable: { status: "DRAFT" } } },
      });
      const upsertErrors = data.metaobjectUpsert?.userErrors || [];
      if (upsertErrors.length) throw new Error(`metaobjectUpsert(${action.handle}): ${upsertErrors.map((e) => e.message).join("; ")}`);
      applied.push({ ...action, gid: ex.id });
    }
  }

  // alterpop.character por produto — um metafieldsSet por product-update. Valor = o que
  // ProductCharacter pede (handles ACTIVE após a corrida), não o atual: remove etiquetas velhas.
  let productWrites = 0;
  for (const action of actionsToApply) {
    if (action.action !== "product-update") continue;
    const gids = action.handles.map((h) => resultingGidByHandle.get(h) ?? existing.get(h)?.id).filter(Boolean);
    const data = await client.graphql(METAFIELDS_SET, {
      metafields: [{ ownerId: action.productId, namespace: NAMESPACE, key: "character", type: "list.metaobject_reference", value: JSON.stringify(gids) }],
    });
    const setErrors = data.metafieldsSet?.userErrors || [];
    if (setErrors.length) throw new Error(`metafieldsSet(${action.productId}, alterpop.character): ${setErrors.map((e) => e.message).join("; ")}`);
    productWrites += 1;
  }

  // alterpop.characters por coleção — recalcula para todos os universos tocados pelas
  // ações aplicadas (mesmo os que ficam sem nenhum Character ACTIVE: valor final = []).
  const universosTocados = new Set(applied.flatMap((a) => a.universos || []));
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
