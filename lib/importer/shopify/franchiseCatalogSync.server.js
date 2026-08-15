import { prisma, safePrisma } from "../../prisma/prismaSafe.server.js";
import { listCurationQueueItems } from "../../curation/curationQueue.server.js";
import { normalizeLicenceLabel } from "./licenceLabel.js";
import { ensureMetafieldDefinition, OCIOSTOCK_FRANCHISE_CATALOG_DEFINITION } from "./metafieldSetup.js";

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
 * Agrega, a partir do CatalogProduct local, todas as licenças/franquias já vistas e
 * se alguma delas tem pelo menos um produto PUBLISHED com stock > 0 — e grava o
 * resultado num metafield de loja (ociostock.franchise_catalog) para a grelha de
 * franquias do tema. Chamado no fim de cada runImport() bem sucedido.
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
    if (!skus.length) return { ok: true, franchiseCount: 0, inStockCount: 0 };

    const rows = await safePrisma(
      "franchiseCatalogSync.loadRows",
      () =>
        prisma.catalogProduct.findMany({
          where: { shop, sku: { in: skus } },
          select: { franchises: true, stock: true },
        }),
      { fallback: [] }
    );

    // label normalizado -> tem pelo menos 1 SKU publicado com stock > 0
    const hasStockByLabel = new Map();
    for (const row of rows) {
      let franchiseList;
      try {
        franchiseList = JSON.parse(row.franchises || "[]");
      } catch {
        continue;
      }
      if (!Array.isArray(franchiseList)) continue;

      const inStock = Number(row.stock) > 0;
      for (const raw of franchiseList) {
        const label = normalizeLicenceLabel(raw);
        if (!label) continue;
        const current = hasStockByLabel.get(label) || false;
        hasStockByLabel.set(label, current || inStock);
      }
    }

    const catalog = Array.from(hasStockByLabel.entries())
      .map(([label, hasStock]) => ({ label, hasStock }))
      .sort((a, b) => a.label.localeCompare(b.label));

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
