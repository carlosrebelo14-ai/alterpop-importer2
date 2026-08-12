import {
  fetchPrimaryLocationId,
  resolveLocationId,
  updateInventory,
} from "../shopifyClient.js";

const VARIANTS_INVENTORY_POLICY = `
  mutation VariantInventoryPolicy($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

/**
 * inventory_policy = deny — não vender acima do stock disponível (Shopify).
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} productId
 * @param {string} variantId
 */
export async function ensureVariantInventoryPolicyDeny(client, productId, variantId) {
  const data = await client.graphql(VARIANTS_INVENTORY_POLICY, {
    productId,
    variants: [
      {
        id: variantId,
        inventoryPolicy: "DENY",
      },
    ],
  });
  const errors = data.productVariantsBulkUpdate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
}

/**
 * Sincroniza stock do catálogo local → Shopify (inventory_item_id + location_id).
 * stock = 0 → esgotado na loja; stock > 0 → quantidade actualizada + política deny.
 *
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {{
 *   productId: string,
 *   variantId: string,
 *   inventoryItemId: string,
 *   stock: number,
 *   locationId?: string,
 *   referenceDocumentUri?: string,
 *   stockBuffer?: number,
 * }} params
 */
export async function syncCatalogStockToShopify(client, params) {
  const {
    productId,
    variantId,
    inventoryItemId,
    stock,
    referenceDocumentUri,
    stockBuffer,
  } = params;

  const locationId =
    params.locationId ||
    (await resolveLocationId(client, process.env.SHOPIFY_LOCATION_ID));

  await ensureVariantInventoryPolicyDeny(client, productId, variantId);

  // Item 17 do roadmap — buffer de segurança subtraído ao stock do fornecedor
  // antes de publicar (ex: fornecedor diz 5, buffer 2 → publica 3). Configurável
  // em Definições, 0 por defeito (comportamento inalterado quando não usado).
  const buffer = Number.isFinite(Number(stockBuffer)) ? Math.max(0, Number(stockBuffer)) : 0;
  const quantity = Math.max(0, Math.floor(Number(stock) || 0) - buffer);

  await updateInventory(client, {
    inventoryItemId,
    locationId,
    quantity,
    referenceDocumentUri,
  });

  return { locationId, quantity };
}

/**
 * @param {import('../shopifyClient.js').ShopifyClient} client
 */
export async function getDefaultShopifyLocationId(client) {
  return fetchPrimaryLocationId(client);
}
