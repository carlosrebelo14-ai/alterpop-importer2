import { prisma, safePrisma } from "../../prisma/prismaSafe.server.js";
import { listCurationQueueItems } from "../../curation/curationQueue.server.js";
import { ensureMetafieldDefinition, OCIOSTOCK_FRANCHISE_CATALOG_DEFINITION } from "./metafieldSetup.js";
import { FRANCHISE_CATALOG_NAMES } from "./franchiseCatalogList.js";

const SHOP_ID_QUERY = `
  query FranchiseCatalogShopId {
    shop { id }
  }
`;

const METAFIELDS_SET = `
  mutation FranchiseCatalogMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }
`;

/**
 * Para a lista curada FRANCHISE_CATALOG_NAMES (ver esse ficheiro para o porquê de não
 * usarmos CatalogProduct.franchises), verifica quais têm pelo menos 1 produto PUBLISHED
 * com stock > 0 cujo título contenha o nome da franquia — e grava o resultado num
 * metafield de loja (ociostock.franchise_catalog) para a grelha de franquias do tema.
 * Chamado no fim de cada ciclo real de sync (ver api.trigger-sync.jsx).
 *
 * Título em vez do campo franchises: o título vem do nome do produto do fornecedor,
 * muito mais fiável para conter o nome real da franquia (ex.: "One Piece Dioramatic...")
 * do que a árvore de categorias.
 *
 * Falha em silêncio (loga e não propaga) — nunca deve fazer um import falhar por
 * causa disto; a grelha do tema já tem um fallback para quando o metafield está
 * vazio ou desatualizado.
 *
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} shop
 * @returns {Promise<{ ok: boolean, franchiseCount?: number, inStockCount?: number, error?: string }>}
 */
export async function syncFranchiseCatalog(client, shop) {
  try {
    const publishedItems = await listCurationQueueItems("PUBLISHED");
    const skus = publishedItems.map((i) => i.sku).filter(Boolean);

    const rows = skus.length
      ? await safePrisma(
          "franchiseCatalogSync.loadRows",
          () =>
            prisma.catalogProduct.findMany({
              where: { shop, sku: { in: skus } },
              select: { title: true, stock: true },
            }),
          { fallback: [] }
        )
      : [];

    // Pré-computa título em minúsculas uma vez, não a cada franquia.
    const titleRows = rows.map((r) => ({
      titleLower: String(r.title || "").toLowerCase(),
      inStock: Number(r.stock) > 0,
    }));

    const catalog = FRANCHISE_CATALOG_NAMES.map((label) => {
      const needle = label.toLowerCase();
      const hasStock = titleRows.some((r) => r.inStock && r.titleLower.includes(needle));
      return { label, hasStock };
    });

    await ensureMetafieldDefinition(client, OCIOSTOCK_FRANCHISE_CATALOG_DEFINITION);

    const shopData = await client.graphql(SHOP_ID_QUERY);
    const shopId = shopData?.shop?.id;
    if (!shopId) throw new Error("Could not resolve shop GID for franchise_catalog metafield");

    const data = await client.graphql(METAFIELDS_SET, {
      metafields: [
        {
          ownerId: shopId,
          namespace: OCIOSTOCK_FRANCHISE_CATALOG_DEFINITION.namespace,
          key: OCIOSTOCK_FRANCHISE_CATALOG_DEFINITION.key,
          type: OCIOSTOCK_FRANCHISE_CATALOG_DEFINITION.type,
          value: JSON.stringify(catalog),
        },
      ],
    });
    const errors = data.metafieldsSet?.userErrors || [];
    if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));

    return {
      ok: true,
      franchiseCount: catalog.length,
      inStockCount: catalog.filter((f) => f.hasStock).length,
    };
  } catch (err) {
    const message = err?.message || String(err);
    return { ok: false, error: message };
  }
}
