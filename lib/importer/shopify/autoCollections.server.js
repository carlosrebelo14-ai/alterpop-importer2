/**
 * Coleções automáticas por licença — item 5 do pacote de melhorias criativas de
 * 2026-08-12. Quando uma licença (franchise) atinge 10+ produtos PUBLISHED, cria uma
 * smart collection Shopify com regra sobre o metafield ociostock.licence.
 *
 * SEGURANÇA: a coleção criada aqui NUNCA é publicada em nenhum canal de vendas
 * (collectionCreate não publica por omissão — só publishablePublish o faria, que este
 * módulo nunca chama). Fica visível apenas no Admin, à espera de confirmação manual.
 * Isto não é negociável mesmo em execução automática — ver AGENTS.md / pedido original.
 *
 * NAMING (2026-08-14): o título já não leva o prefixo "[Auto] Licença: " — passa a ser
 * só o nome da licença. Para não duplicar uma franquia já existente sob outro nome (ex.:
 * feed manda "chainsawman" numa palavra, já existe "Chainsaw Man" manual), ANTES de criar
 * comparamos o label normalizado (sem espaços/pontuação, lowercase) contra o título de
 * TODAS as collections já existentes na loja (manuais + auto, published ou não). Se bater
 * com alguma, não criamos nada — gravamos o id da collection existente na tabela de
 * tracking, na mesma, para o dedup por licença continuar a funcionar para sempre e não
 * repetirmos a comparação em todos os ciclos seguintes.
 */
import { prisma, safePrisma } from "../../prisma/prismaSafe.server.js";
import { listCurationQueueItems } from "../../curation/curationQueue.server.js";
import { ensureMetafieldDefinition, OCIOSTOCK_LICENCE_DEFINITION } from "./metafieldSetup.js";
import { normalizeLicenceLabel } from "./licenceLabel.js";

export const LICENCE_COLLECTION_THRESHOLD = 10;

/** Limite de SKUs por query IN — evita o limite de parâmetros do SQLite em lojas com
 * muitos produtos publicados (ver precedente em catalogProductsDb.server.js). */
const SKU_CHUNK_SIZE = 500;

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const COLLECTION_CREATE = `
  mutation AutoLicenceCollectionCreate($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection { id title }
      userErrors { field message }
    }
  }
`;

const EXISTING_COLLECTIONS_QUERY = `
  query AutoLicenceExistingCollections($cursor: String) {
    collections(first: 250, after: $cursor) {
      nodes { id title }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

function licenceKey(label) {
  return String(label || "").trim().toLowerCase();
}

/** Palavras genéricas que só aparecem por convenção de branding da loja (ex.: título
 * manual "DC Universe" vs. label do feed "Dc Comics" — o produto é o mesmo, a palavra a
 * mais é que difere). Lista deliberadamente curta e conservadora: cada palavra aqui deixa
 * de contar para o match, por isso uma entrada demasiado genérica arrisca colidir com uma
 * licença nova e legítima (ex.: NÃO incluir "collection"/"collectibles" — já usamos como
 * nome de franquia real em "Premium Collectibles"). Só adicionar palavras que nunca seriam,
 * sozinhas, o nome de uma licença. */
const MATCH_NOISE_WORDS = new Set(["universe", "comics", "official"]);

/** Normalização "fuzzy" para comparar nomes de franquia entre fontes diferentes (feed do
 * fornecedor vs. título já escolhido à mão na loja): lowercase, remove acentos e palavras-
 * ruído de branding, e junta o resto sem separadores — para "Chainsaw Man"/"chainsawman" e
 * "DC Universe"/"Dc Comics" darem o mesmo valor, sem arriscar apanhar franquias diferentes
 * por acidente (mesma cautela que o `franchise-nav-link.liquid` do tema já aplicava). */
function normalizeForMatch(label) {
  const ascii = String(label || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // remove acentos (marcas diacríticas após NFD)
  return ascii
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !MATCH_NOISE_WORDS.has(word))
    .join("");
}

/**
 * Busca todas as collections existentes na loja (qualquer tipo/estado de publicação) e
 * devolve um Map normalizeForMatch(title) -> { id, title }, para checar duplicados antes
 * de criar uma nova coleção automática.
 * @param {import('../shopifyClient.js').ShopifyClient} client
 */
async function fetchExistingCollectionTitles(client) {
  const map = new Map();
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const data = await client.graphql(EXISTING_COLLECTIONS_QUERY, { cursor });
    const nodes = data?.collections?.nodes || [];
    for (const node of nodes) {
      const key = normalizeForMatch(node.title);
      if (key && !map.has(key)) map.set(key, { id: node.id, title: node.title });
    }
    const pageInfo = data?.collections?.pageInfo;
    if (!pageInfo?.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }
  return map;
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
  const rowChunks = await Promise.all(
    chunkArray(skus, SKU_CHUNK_SIZE).map((chunk) =>
      safePrisma("autoCollections.franchises", () =>
        prisma.catalogProduct.findMany({
          where: { shop, sku: { in: chunk } },
          select: { sku: true, franchises: true },
        }),
        { rethrow: false, fallback: [] }
      )
    )
  );

  const byKey = new Map();
  for (const row of rowChunks.flat()) {
    let franchises = [];
    try {
      franchises = JSON.parse(row.franchises || "[]");
    } catch {
      /* ignore */
    }
    // Normalizado (Title Case) — mesma forma canónica gravada no metafield de cada
    // produto (setLicenceMetafield), para a condição EQUALS da regra bater sempre
    // certo independentemente do casing de origem no CSV do fornecedor.
    const primary = normalizeLicenceLabel(franchises?.[0]);
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
    if (!qualifying.length) return { created: [], matched: [] };

    const existing = await safePrisma("autoCollections.existing", () =>
      prisma.autoCollectionLicence.findMany({ where: { shop } }),
      { rethrow: false, fallback: [] }
    );
    const existingKeys = new Set(existing.map((r) => r.licenceKey));
    const toCreate = qualifying.filter(([key]) => !existingKeys.has(key));
    if (!toCreate.length) return { created: [], matched: [] };

    const { definition } = await ensureMetafieldDefinition(client, OCIOSTOCK_LICENCE_DEFINITION);
    const existingTitles = await fetchExistingCollectionTitles(client);

    const created = [];
    const matched = [];
    for (const [key, { label, skus }] of toCreate) {
      try {
        const found = existingTitles.get(normalizeForMatch(label));
        if (found) {
          // Já existe uma collection (manual ou auto) com este nome, só que sob outra
          // grafia/label do feed — não criar uma segunda. Gravamos na mesma o mapeamento
          // para o dedup por licença nunca mais voltar a comparar esta licença.
          await safePrisma("autoCollections.record", () =>
            prisma.autoCollectionLicence.create({
              data: {
                shop,
                licenceKey: key,
                licenceLabel: label,
                shopifyCollectionId: found.id,
                productCountAtCreate: skus.length,
              },
            })
          );
          matched.push({ licence: label, existingCollectionId: found.id, existingTitle: found.title });
          continue;
        }

        const data = await client.graphql(COLLECTION_CREATE, {
          input: {
            title: label,
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
    if (matched.length) {
      console.log(
        `[autoCollections] ${matched.length} licença(s) já tinham collection existente, não duplicadas: ${matched
          .map((m) => `${m.licence} → "${m.existingTitle}"`)
          .join(", ")}`
      );
    }
    return { created, matched };
  } catch (err) {
    console.error("[autoCollections] ciclo falhou (não fatal):", err?.message || err);
    return { created: [], matched: [] };
  }
}

/** @param {string} shop */
export async function listAutoCollections(shop) {
  return safePrisma("autoCollections.list", () =>
    prisma.autoCollectionLicence.findMany({ where: { shop }, orderBy: { createdAt: "desc" } }),
    { rethrow: false, fallback: [] }
  );
}
