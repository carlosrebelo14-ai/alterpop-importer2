/**
 * Coleções automáticas por licença — item 5 do pacote de melhorias criativas de
 * 2026-08-12. Quando uma licença (franchise) atinge 10+ produtos PUBLISHED, cria uma
 * smart collection Shopify com regra sobre o metafield ociostock.licence.
 *
 * SEGURANÇA: a coleção criada aqui NUNCA é publicada em nenhum canal de vendas
 * (collectionCreate não publica por omissão — só publishablePublish o faria, que este
 * módulo nunca chama). Fica visível apenas no Admin, à espera de confirmação manual.
 * Isto não é negociável mesmo em execução automática — ver AGENTS.md / pedido original.
 */
import { prisma, safePrisma } from "../../prisma/prismaSafe.server.js";
import { listCurationQueueItems } from "../../curation/curationQueue.server.js";
import { ensureMetafieldDefinition, OCIOSTOCK_LICENCE_DEFINITION } from "./metafieldSetup.js";

export const LICENCE_COLLECTION_THRESHOLD = 10;

const COLLECTION_CREATE = `
  mutation AutoLicenceCollectionCreate($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection { id title }
      userErrors { field message }
    }
  }
`;

function licenceKey(label) {
  return String(label || "").trim().toLowerCase();
}

/**
 * Conta produtos PUBLISHED por licença primária, cruzando a fila de curadoria
 * (estado de publicação) com CatalogProduct (franchises).
 * @param {string} shop
 * @returns {Promise<Map<string, { label: string, skus: string[] }>>}
 */
async function countPublishedByLicence(shop) {
  const published = await listCurationQueueItems("PUBLISHED");
  if (!published.length) return new Map();

  const skus = published.map((i) => i.sku);
  const rows = await safePrisma("autoCollections.franchises", () =>
    prisma.catalogProduct.findMany({
      where: { shop, sku: { in: skus } },
      select: { sku: true, franchises: true },
    }),
    { rethrow: false, fallback: [] }
  );

  const byKey = new Map();
  for (const row of rows) {
    let franchises = [];
    try {
      franchises = JSON.parse(row.franchises || "[]");
    } catch {
      /* ignore */
    }
    const primary = String(franchises?.[0] || "").trim();
    if (!primary) continue;
    const key = licenceKey(primary);
    if (!byKey.has(key)) byKey.set(key, { label: primary, skus: [] });
    byKey.get(key).skus.push(row.sku);
  }
  return byKey;
}

/**
 * Corre no fim de um ciclo de publicação — não bloqueia nem falha o ciclo.
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} shop
 */
export async function checkAndCreateLicenceCollections(client, shop) {
  try {
    const counts = await countPublishedByLicence(shop);
    const qualifying = [...counts.entries()].filter(
      ([, v]) => v.skus.length >= LICENCE_COLLECTION_THRESHOLD
    );
    if (!qualifying.length) return { created: [] };

    const existing = await safePrisma("autoCollections.existing", () =>
      prisma.autoCollectionLicence.findMany({ where: { shop } }),
      { rethrow: false, fallback: [] }
    );
    const existingKeys = new Set(existing.map((r) => r.licenceKey));
    const toCreate = qualifying.filter(([key]) => !existingKeys.has(key));
    if (!toCreate.length) return { created: [] };

    const { definition } = await ensureMetafieldDefinition(client, OCIOSTOCK_LICENCE_DEFINITION);

    const created = [];
    for (const [key, { label, skus }] of toCreate) {
      try {
        const data = await client.graphql(COLLECTION_CREATE, {
          input: {
            title: `[Auto] Licença: ${label}`,
            descriptionHtml: `Coleção criada automaticamente — ${skus.length} produtos publicados da licença "${label}" (limiar: ${LICENCE_COLLECTION_THRESHOLD}). Rascunho: confirma manualmente e publica num canal de vendas no Admin para ficar visível.`,
            ruleSet: {
              appliedDisjunctively: false,
              rules: [
                {
                  column: "PRODUCT_METAFIELD_DEFINITION",
                  relation: "EQUALS",
                  condition: label,
                  conditionObjectId: definition.id,
                },
              ],
            },
          },
        });
        const errors = data.collectionCreate?.userErrors || [];
        const collection = data.collectionCreate?.collection;
        if (errors.length || !collection?.id) {
          console.warn(
            `[autoCollections] falhou para licença "${label}":`,
            errors.map((e) => e.message).join("; ") || "sem coleção devolvida"
          );
          continue;
        }

        await safePrisma("autoCollections.record", () =>
          prisma.autoCollectionLicence.create({
            data: {
              shop,
              licenceKey: key,
              licenceLabel: label,
              shopifyCollectionId: collection.id,
              productCountAtCreate: skus.length,
            },
          })
        );
        created.push({ licence: label, collectionId: collection.id, productCount: skus.length });
      } catch (err) {
        console.warn(`[autoCollections] erro a criar coleção "${label}":`, err?.message || err);
      }
    }

    if (created.length) {
      console.log(
        `[autoCollections] ${created.length} nova(s) smart collection(s) em rascunho: ${created
          .map((c) => c.licence)
          .join(", ")}`
      );
    }
    return { created };
  } catch (err) {
    console.error("[autoCollections] ciclo falhou (não fatal):", err?.message || err);
    return { created: [] };
  }
}

/** @param {string} shop */
export async function listAutoCollections(shop) {
  return safePrisma("autoCollections.list", () =>
    prisma.autoCollectionLicence.findMany({ where: { shop }, orderBy: { createdAt: "desc" } }),
    { rethrow: false, fallback: [] }
  );
}
