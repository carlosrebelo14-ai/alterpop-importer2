import { resolveVariantBySku } from "../lib/resolveSku.js";
import { ensureOciostockMetafieldDefinitions } from "./metafieldSetup.js";
import { mapCatalogProductToShopifyPayload } from "./shopifyMapper.server.js";
import { syncCatalogStockToShopify } from "./shopifyInventorySync.server.js";

const PRODUCT_CREATE = `
  mutation ProductCreate($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product {
        id
        title
        variants(first: 1) {
          nodes { id sku inventoryItem { id } }
        }
      }
      userErrors { field message }
    }
  }
`;

const PRODUCT_UPDATE = `
  mutation ProductUpdate($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id title }
      userErrors { field message }
    }
  }
`;

const VARIANTS_BULK_UPDATE = `
  mutation VariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id sku barcode inventoryItem { id } }
      userErrors { field message }
    }
  }
`;

const PRODUCT_CREATE_MEDIA = `
  mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media { id }
      mediaUserErrors { field message }
    }
  }
`;

const METAFIELDS_SET = `
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id }
      userErrors { field message }
    }
  }
`;

const GET_PUBLICATIONS = `
  query GetPublications {
    publications(first: 10) {
      nodes { id name }
    }
  }
`;

const PUBLISHABLE_PUBLISH = `
  mutation PublishablePublish($id: ID!, $input: [PublicationInput!]!) {
    publishablePublish(id: $id, input: $input) {
      publishable { availablePublicationCount }
      userErrors { field message }
    }
  }
`;

/**
 * Registo de auditoria antes de cada envio à Shopify Admin API.
 * @param {object} catalogRow
 * @param {Awaited<ReturnType<typeof mapCatalogProductToShopifyPayload>>} mapped
 */
function logShopifyPublishAudit(catalogRow, mapped) {
  console.log("📦 Sincronizando Produto Completo:", {
    title: mapped.title,
    sku: mapped.sku,
    stock: mapped.stock,
    barcode: mapped.barcode,
    vendor: mapped.vendor,
    weightKg: mapped.weightKg,
    retailPrice: mapped.retailPrice,
    sourceBarcode: catalogRow.barcode ?? null,
    sourceVendor: catalogRow.vendor ?? null,
  });
}

/**
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} sku
 * @param {Map<string, object>} cache
 */
async function resolveInventoryItemId(client, sku, cache) {
  const variant = await resolveVariantBySku(client, sku, cache);
  return variant?.inventoryItem?.id || null;
}

/**
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} productId
 * @param {string} variantId
 * @param {Awaited<ReturnType<typeof mapCatalogProductToShopifyPayload>>} mapped
 */
async function applyVariantDetails(client, productId, variantId, mapped) {
  const v = mapped.graphql.variant;
  /** @type {Record<string, unknown>} */
  const variantInput = {
    id: variantId,
    inventoryPolicy: v.inventoryPolicy || "DENY",
    inventoryItem: {
      sku: mapped.sku,
      tracked: true,
    },
  };

  if (v.barcode) {
    variantInput.barcode = v.barcode;
  }

  if (mapped.retailPrice != null) {
    variantInput.price = String(mapped.retailPrice.toFixed(2));
  }

  const bulkData = await client.graphql(VARIANTS_BULK_UPDATE, {
    productId,
    variants: [variantInput],
  });
  const bulkErrors = bulkData.productVariantsBulkUpdate?.userErrors || [];
  if (bulkErrors.length) {
    throw new Error(bulkErrors.map((e) => e.message).join("; "));
  }

  const updatedNode = bulkData.productVariantsBulkUpdate?.productVariants?.[0];
  return updatedNode?.inventoryItem?.id || null;
}

/**
 * Stock + política deny na localização configurada (inventory_item_id obrigatório).
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {{
 *   productId: string,
 *   variantId: string,
 *   inventoryItemId: string,
 *   mapped: Awaited<ReturnType<typeof mapCatalogProductToShopifyPayload>>,
 *   locationId?: string,
 * }} params
 */
async function pushInventoryAfterPublish(client, params) {
  const { productId, variantId, inventoryItemId, mapped, locationId } = params;

  const result = await syncCatalogStockToShopify(client, {
    productId,
    variantId,
    inventoryItemId,
    stock: mapped.stock ?? 0,
    locationId,
  });

  console.log("📦 Stock Shopify actualizado:", {
    sku: mapped.sku,
    quantity: result.quantity,
    locationId: result.locationId,
    inventoryItemId,
  });

  return result;
}

/**
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {object} catalogRow
 * @param {{
 *   variantCache?: Map<string, object>,
 *   metafieldReady?: boolean,
 *   locationId?: string,
 *   customTags?: string[],
 * }} [opts]
 */
export async function publishCatalogProductToShopify(client, catalogRow, opts = {}) {
  const cache = opts.variantCache || new Map();
  let metafieldReady = opts.metafieldReady;

  if (metafieldReady === undefined) {
    const noopJob = { log: () => {} };
    metafieldReady = await ensureOciostockMetafieldDefinitions(client, noopJob);
  }

  const mapped = await mapCatalogProductToShopifyPayload(catalogRow, { status: "ACTIVE", customTags: opts.customTags });
  logShopifyPublishAudit(catalogRow, mapped);

  const existing = await resolveVariantBySku(client, mapped.sku, cache);
  const ctx = { variantCache: cache, locationId: opts.locationId };

  if (existing?.product?.id) {
    return updateExistingProduct(client, mapped, existing, metafieldReady, ctx);
  }

  return createNewProduct(client, mapped, metafieldReady, ctx);
}

/**
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {Awaited<ReturnType<typeof mapCatalogProductToShopifyPayload>>} mapped
 * @param {object} variant
 * @param {boolean} metafieldReady
 * @param {{ variantCache?: Map<string, object>, locationId?: string }} ctx
 */
async function updateExistingProduct(client, mapped, variant, metafieldReady, ctx) {
  const cache = ctx.variantCache || new Map();

  const input = {
    id: variant.product.id,
    title: mapped.title,
    vendor: mapped.vendor,
    productType: mapped.productType,
    descriptionHtml: mapped.descriptionHtml,
    status: mapped.status,
    tags: mapped.tags,
  };

  const data = await client.graphql(PRODUCT_UPDATE, { input });
  const errors = data.productUpdate?.userErrors || [];
  if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));

  let inventoryItemId =
    (await applyVariantDetails(client, variant.product.id, variant.id, mapped)) ||
    variant.inventoryItem?.id;

  if (!inventoryItemId) {
    inventoryItemId = await resolveInventoryItemId(client, mapped.sku, cache);
  }

  await attachMedia(client, variant.product.id, mapped);
  if (metafieldReady) await setNetPriceMetafield(client, variant.product.id, mapped.netPrice);
  await ensurePublishedToOnlineStore(client, variant.product.id);

  if (inventoryItemId) {
    await pushInventoryAfterPublish(client, {
      productId: variant.product.id,
      variantId: variant.id,
      inventoryItemId,
      mapped,
      locationId: ctx.locationId,
    });
  } else {
    console.warn(`[shopify-publish] Sem inventory_item_id para SKU ${mapped.sku} — stock não sincronizado`);
  }

  return {
    action: "updated",
    shopifyProductId: variant.product.id,
    variantId: variant.id,
    inventoryItemId: inventoryItemId || null,
  };
}

/**
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {Awaited<ReturnType<typeof mapCatalogProductToShopifyPayload>>} mapped
 * @param {boolean} metafieldReady
 * @param {{ variantCache?: Map<string, object>, locationId?: string }} ctx
 */
async function createNewProduct(client, mapped, metafieldReady, ctx) {
  const cache = ctx.variantCache || new Map();

  const data = await client.graphql(PRODUCT_CREATE, {
    product: mapped.graphql.product,
  });
  const errors = data.productCreate?.userErrors || [];
  if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));

  const created = data.productCreate.product;
  const variantNode = created.variants?.nodes?.[0];
  if (!variantNode?.id) throw new Error("Produto criado sem variante por defeito");

  let inventoryItemId =
    (await applyVariantDetails(client, created.id, variantNode.id, mapped)) ||
    variantNode.inventoryItem?.id;

  if (!inventoryItemId) {
    inventoryItemId = await resolveInventoryItemId(client, mapped.sku, cache);
  }

  await attachMedia(client, created.id, mapped);
  if (metafieldReady) await setNetPriceMetafield(client, created.id, mapped.netPrice);
  await ensurePublishedToOnlineStore(client, created.id);

  if (inventoryItemId) {
    await pushInventoryAfterPublish(client, {
      productId: created.id,
      variantId: variantNode.id,
      inventoryItemId,
      mapped,
      locationId: ctx.locationId,
    });
  } else {
    console.warn(`[shopify-publish] Sem inventory_item_id para SKU ${mapped.sku} — stock não sincronizado`);
  }

  return {
    action: "created",
    shopifyProductId: created.id,
    variantId: variantNode.id,
    inventoryItemId: inventoryItemId || null,
  };
}

let cachedOnlineStorePublicationId = null;

async function ensurePublishedToOnlineStore(client, productId) {
  try {
    if (!cachedOnlineStorePublicationId) {
      const pubData = await client.graphql(GET_PUBLICATIONS);
      const nodes = pubData.publications?.nodes || [];
      const onlineStoreNode =
        nodes.find((n) => /online store|loja online/i.test(n.name)) || nodes[0];
      if (onlineStoreNode?.id) {
        cachedOnlineStorePublicationId = onlineStoreNode.id;
      }
    }

    if (cachedOnlineStorePublicationId) {
      const pubRes = await client.graphql(PUBLISHABLE_PUBLISH, {
        id: productId,
        input: [{ publicationId: cachedOnlineStorePublicationId }],
      });
      const pubErrors = pubRes.publishablePublish?.userErrors || [];
      if (pubErrors.length) {
        console.warn(`[shopify-publish] Aviso ao publicar no canal de vendas para ${productId}:`, pubErrors.map((e) => e.message).join("; "));
      } else {
        console.log(`[shopify-publish] Produto ${productId} publicado no canal de vendas Online Store: ${cachedOnlineStorePublicationId}`);
      }
    }
  } catch (err) {
    console.warn(`[shopify-publish] Excepção ao publicar no canal de vendas para ${productId}:`, err?.message || err);
  }
}

/**
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} productId
 * @param {Awaited<ReturnType<typeof mapCatalogProductToShopifyPayload>>} mapped
 */
async function attachMedia(client, productId, mapped) {
  const media = mapped.graphql.media;
  if (!media?.length) return;

  try {
    const data = await client.graphql(PRODUCT_CREATE_MEDIA, { productId, media });
    const errors = data.productCreateMedia?.mediaUserErrors || [];
    if (errors.length) {
      console.warn(`[shopify-publish] Falha de media para ${productId}:`, errors.map((e) => e.message).join("; "));
    }
  } catch (err) {
    console.warn(`[shopify-publish] Excepção de media para ${productId}:`, err?.message || err);
  }
}

/**
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} productId
 * @param {number|null|undefined} netPrice
 */
async function setNetPriceMetafield(client, productId, netPrice) {
  if (netPrice == null || !Number.isFinite(netPrice)) return;

  const data = await client.graphql(METAFIELDS_SET, {
    metafields: [
      {
        ownerId: productId,
        namespace: "ociostock",
        key: "net_price",
        type: "number_decimal",
        value: String(netPrice.toFixed(2)),
      },
    ],
  });
  const errors = data.metafieldsSet?.userErrors || [];
  if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
}
