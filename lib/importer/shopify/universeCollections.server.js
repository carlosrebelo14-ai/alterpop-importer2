/**
 * Coleções Universe — Fase 7 da normalização de franquias.
 *
 * Para cada universo ATIVO da tabela dos 41 (baseline ≥ 10), garante uma smart
 * collection com:
 *   - título   = universe.name (nome canónico EN)
 *   - handle   = universe.handle
 *   - regra    = alterpop.franchise EQUALS <universe.name>   (appliedDisjunctively: false)
 *   - template = universe-room
 *
 * NUNCA publica em canal de vendas — só `collectionCreate` / `collectionUpdate`, nunca
 * `publishablePublish`. Fica em rascunho à espera de confirmação manual no Admin.
 * (mesma regra dura de autoCollections.server.js — ver cabeçalho desse ficheiro).
 *
 * Substitui a função de `autoCollections.server.js` (que ficou legacy, sem caller).
 * NÃO toca nas ~24 coleções `auto-licenca-*` nem nas outras com regra sobre
 * `ociostock.licence` — essas são outra história, apagam-se à parte.
 *
 * Dedup: compara o título normalizado (normalizeForMatch) de cada universo ativo com
 * TODAS as coleções da loja.
 *   - sem correspondência           → toCreate (cria nova, rascunho)
 *   - correspondência por título     → toAdopt: já existe uma coleção com este nome
 *                                      (tipicamente as smart collections da era Crave,
 *                                      com regra sobre TITLE/TAG). ADOTAR = manter o
 *                                      handle/URL e trocar a regra para alterpop.franchise
 *                                      + pôr templateSuffix. Decisão do Carlos por universo.
 *
 * Persistência do dedup: tabela `UniverseCollection` (handle-keyed) — a criar na migração
 * quando a Fase 7 executar a sério. O dry-run não escreve nada.
 */
import {
  FRANCHISE_UNIVERSES,
  UNIVERSE_TEMPLATE_SUFFIX,
} from "../catalog/franchiseUniverses.js";
import { ALTERPOP_FRANCHISE_DEFINITION_GID } from "./franchiseMetafieldDefinition.js";

const NOISE_WORDS = new Set(["universe", "comics", "official"]);

/** lowercase + sem acentos + sem palavras-ruído de branding + junta alfanuméricos.
 *  Mesmo espírito de autoCollections.normalizeForMatch. */
export function normalizeForMatch(label) {
  return String(label || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !NOISE_WORDS.has(w))
    .join("");
}

const EXISTING_COLLECTIONS_QUERY = `
  query UniverseCollExisting($cursor: String) {
    collections(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id handle title templateSuffix
        productsCount { count }
        ruleSet { appliedDisjunctively rules { column relation condition } }
      }
    }
  }
`;

const COLLECTION_CREATE = `
  mutation UniverseCollCreate($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection { id handle title templateSuffix }
      userErrors { field message }
    }
  }
`;

const COLLECTION_UPDATE = `
  mutation UniverseCollUpdate($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection { id handle title templateSuffix }
      userErrors { field message }
    }
  }
`;

function franchiseRule(universeName) {
  return {
    appliedDisjunctively: false,
    rules: [
      {
        column: "PRODUCT_METAFIELD_DEFINITION",
        relation: "EQUALS",
        condition: universeName,
        conditionObjectId: ALTERPOP_FRANCHISE_DEFINITION_GID,
      },
    ],
  };
}

/** @param {import('../shopifyClient.js').ShopifyClient} client */
async function fetchAllCollections(client) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const data = await client.graphql(EXISTING_COLLECTIONS_QUERY, { cursor });
    const conn = data?.collections;
    for (const n of conn?.nodes || []) out.push(n);
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}

/**
 * Calcula o plano. Não escreve nada.
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @returns {Promise<{ toCreate: object[], toAdopt: object[], dormant: object[], existingCount: number }>}
 */
export async function planUniverseCollections(client) {
  const existing = await fetchAllCollections(client);
  const byNorm = new Map();
  for (const c of existing) {
    const k = normalizeForMatch(c.title);
    if (k && !byNorm.has(k)) byNorm.set(k, c);
  }

  const toCreate = [];
  const toAdopt = [];
  for (const u of FRANCHISE_UNIVERSES) {
    if (!u.active) continue;
    const match = byNorm.get(normalizeForMatch(u.name));
    const entry = { handle: u.handle, name: u.name, baseline: u.baseline };
    if (match) {
      toAdopt.push({
        ...entry,
        existing: {
          id: match.id,
          handle: match.handle,
          title: match.title,
          templateSuffix: match.templateSuffix || null,
          productsCount: match.productsCount?.count ?? null,
          ruleColumn: match.ruleSet?.rules?.[0]?.column ?? "MANUAL",
        },
      });
    } else {
      toCreate.push(entry);
    }
  }

  const dormant = FRANCHISE_UNIVERSES.filter((u) => !u.active).map((u) => ({
    handle: u.handle,
    name: u.name,
    baseline: u.baseline,
  }));

  return { toCreate, toAdopt, dormant, existingCount: existing.length };
}

/**
 * Cria as coleções `toCreate` em rascunho. NÃO adota nada (isso exige decisão por
 * universo — passar `adoptHandles` com os handles de universo aprovados).
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {{ adoptHandles?: string[] }} [opts]
 */
export async function createUniverseCollections(client, opts = {}) {
  const { toCreate, toAdopt } = await planUniverseCollections(client);
  const adopt = new Set(opts.adoptHandles || []);
  const created = [];
  const adopted = [];

  for (const u of toCreate) {
    const data = await client.graphql(COLLECTION_CREATE, {
      input: {
        title: u.name,
        handle: u.handle,
        templateSuffix: UNIVERSE_TEMPLATE_SUFFIX,
        ruleSet: franchiseRule(u.name),
        descriptionHtml: `Coleção Universe — produtos com alterpop.franchise = "${u.name}". Rascunho: confirmar e publicar no Admin.`,
      },
    });
    const errs = data.collectionCreate?.userErrors || [];
    if (errs.length || !data.collectionCreate?.collection?.id) {
      console.warn(`[universeCollections] falhou criar "${u.name}": ${errs.map((e) => e.message).join("; ")}`);
      continue;
    }
    created.push(data.collectionCreate.collection);
  }

  for (const u of toAdopt) {
    if (!adopt.has(u.handle)) continue;
    const data = await client.graphql(COLLECTION_UPDATE, {
      input: {
        id: u.existing.id,
        templateSuffix: UNIVERSE_TEMPLATE_SUFFIX,
        ruleSet: franchiseRule(u.name),
      },
    });
    const errs = data.collectionUpdate?.userErrors || [];
    if (errs.length) {
      console.warn(`[universeCollections] falhou adotar "${u.name}" (${u.existing.handle}): ${errs.map((e) => e.message).join("; ")}`);
      continue;
    }
    adopted.push(data.collectionUpdate.collection);
  }

  return { created, adopted };
}
