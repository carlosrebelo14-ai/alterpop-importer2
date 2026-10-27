/**
 * characterCreate — passos 3 e 4 do pipeline antes do productCreate (PR 4, desvio 2 do
 * arquiteto de 27/10/2026). Assim alterpop.franchise e alterpop.character entram no input
 * `metafields` do mesmo productCreate, e o P1 (produto publicado sem personagem nem
 * franquia) não se abre.
 *
 * - Passo 3: resolver → ProductCharacter (origem "resolver"). Ver productCharacterLinks.
 * - Passo 4: metaobjectUpsert só para handles que não existem na loja, em DRAFT, sem
 *   `products`. Nunca altera um metaobject que já existe.
 */
import { resolveCharacters } from "../catalog/characterResolver.server.js";
import { buildCharacterCatalog } from "../catalog/characterPages.server.js";
import { getUniverseByName } from "../catalog/franchiseUniverses.js";
import { planProductCharacterLinks } from "../catalog/productCharacterLinks.js";
import { applyLinkPlan } from "./productCharacterLinks.server.js";
import { resolveCollectionGid } from "./characterPagesSync.server.js";
import { CHARACTER_METAOBJECT_TYPE } from "./characterMetaobjectSetup.js";

const METAOBJECT_BY_HANDLE = `
  query CharacterByHandle($handle: MetaobjectHandleInput!) {
    metaobjectByHandle(handle: $handle) { id handle }
  }
`;

const METAOBJECT_UPSERT_DRAFT = `
  mutation CharacterCreateDraft($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
    metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
      metaobject { id handle }
      userErrors { field message code }
    }
  }
`;

/**
 * Input `metafields` do productCreate. Função pura.
 * @param {{ franchiseName?: string|null, characterGids?: string[] }} input
 * @returns {Array<{ namespace: string, key: string, type: string, value: string }>}
 */
export function buildCreateMetafields({ franchiseName, characterGids = [] }) {
  const out = [];
  const name = String(franchiseName || "").trim().normalize("NFC");
  // Mesma regra de setFranchiseMetafield: um universo dormente não tem coleção e não recebe franquia.
  if (name && !getUniverseByName(name)?.dormant) {
    out.push({ namespace: "alterpop", key: "franchise", type: "list.single_line_text_field", value: JSON.stringify([name]) });
  }
  if (characterGids.length) {
    out.push({ namespace: "alterpop", key: "character", type: "list.metaobject_reference", value: JSON.stringify(characterGids) });
  }
  return out;
}

/**
 * Passo 4 para uma lista de handles. Devolve GIDs na mesma ordem.
 * Lança erro visível se a Shopify recusar a criação (ex.: campo obrigatório em branco).
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string[]} handles
 * @param {string} universeName
 */
export async function ensureCharacterGids(client, handles, universeName) {
  if (!handles.length) return [];
  const catalog = buildCharacterCatalog();
  const universeGid = await resolveCollectionGid(client, universeName);
  const gids = [];
  for (const handle of handles) {
    const found = await client.graphql(METAOBJECT_BY_HANDLE, { handle: { type: CHARACTER_METAOBJECT_TYPE, handle } });
    if (found?.metaobjectByHandle?.id) {
      gids.push(found.metaobjectByHandle.id);
      continue;
    }
    const nome = catalog.get(handle)?.nome || handle;
    const data = await client.graphql(METAOBJECT_UPSERT_DRAFT, {
      handle: { type: CHARACTER_METAOBJECT_TYPE, handle },
      metaobject: {
        capabilities: { publishable: { status: "DRAFT" } },
        fields: [
          { key: "title", value: nome },
          { key: "universe", value: JSON.stringify([universeGid]) },
        ],
      },
    });
    const errors = data?.metaobjectUpsert?.userErrors || [];
    if (errors.length) throw new Error(`metaobjectUpsert(${handle}): ${errors.map((e) => e.message).join("; ")}`);
    gids.push(data.metaobjectUpsert.metaobject.id);
  }
  return gids;
}

/**
 * Passos 3 e 4 para um produto novo. Devolve os GIDs a pôr no productCreate.
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {{ shop: string, sku: string, originalTitle?: string|null, titleOverride?: string|null }} row
 * @param {string|null} resolvedFranchise
 */
export async function prepareCharacterLinksForCreate(client, row, resolvedFranchise) {
  const handles = resolveCharacters({
    originalTitle: row.originalTitle,
    titleOverride: row.titleOverride,
    resolvedFranchise,
  });
  if (!handles?.length) return [];
  const plan = planProductCharacterLinks({
    products: [{ sku: row.sku, originalTitle: row.originalTitle, titleOverride: row.titleOverride, resolvedFranchise }],
    existingLinks: new Map(),
  });
  await applyLinkPlan(row.shop, plan);
  return ensureCharacterGids(client, handles, resolvedFranchise);
}
