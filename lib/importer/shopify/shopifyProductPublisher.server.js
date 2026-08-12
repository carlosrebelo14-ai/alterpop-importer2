import { resolveVariantBySku } from "../lib/resolveSku.js";
import { ensureOciostockMetafieldDefinitions } from "./metafieldSetup.js";
import { mapCatalogProductToShopifyPayload } from "./shopifyMapper.server.js";
import { syncCatalogStockToShopify } from "./shopifyInventorySync.server.js";
import { getCurationQueueEntry } from "../../curation/curationQueue.server.js";
import { loadTaxonomyMap } from "../catalog/taxonomy.server.js";

const VALID_CATEGORY_ID_RE = /^[a-zA-Z0-9\-.]+$/;

/**
 * Resolve o texto de um override de categoria para o GID oficial da Standard Product
 * Taxonomy, SE bater certo (case-insensitive) com uma das 57 etiquetas já revistas
 * manualmente em taxonomy-map.json > shopifyCategoryIds (ex: "T-Shirt", "WallClock").
 * Devolve undefined se não houver correspondência — nunca inventa/adivinha um GID.
 * @param {string} categoryOverrideText
 * @returns {string|undefined}
 */
function resolveCategoryOverrideGid(categoryOverrideText) {
  const norm = String(categoryOverrideText || "").trim().toLowerCase();
  if (!norm) return undefined;
  const { shopifyCategoryIds } = loadTaxonomyMap();
  for (const [key, id] of Object.entries(shopifyCategoryIds || {})) {
    if (key.startsWith("_")) continue;
    if (key.toLowerCase() === norm && VALID_CATEGORY_ID_RE.test(id) && id.length >= 2) {
      return `gid://shopify/TaxonomyCategory/${id}`;
    }
  }
  return undefined;
}

/**
 * Aplica overrides manuais (título/preço/categoria) gravados via re-import de CSV
 * (setManualOverride em curationQueue.server.js), por cima do que veio mapeado do
 * fornecedor. Muda `mapped` em memória, antes de qualquer chamada GraphQL.
 * @param {Awaited<ReturnType<typeof mapCatalogProductToShopifyPayload>>} mapped
 * @param {{ title?: string, price?: number, category?: string }} [overrides]
 */
function applyManualOverrides(mapped, overrides) {
  if (!overrides) return mapped;

  if (overrides.title) {
    mapped.title = overrides.title;
    mapped.graphql.product.title = overrides.title;
    mapped.restProduct.product.title = overrides.title;
  }
  if (overrides.category) {
    mapped.productType = overrides.category;
    mapped.graphql.product.productType = overrides.category;
    mapped.restProduct.product.product_type = overrides.category;

    // Só muda a Categoria oficial da Shopify (taxonomia) quando o texto do override
    // bate certo com uma etiqueta já revista manualmente — nunca manda um GID
    // adivinhado. Sem correspondência, o override continua a mudar só o productType
    // de texto livre, como antes (achado do code review, 2026-08-12).
    const categoryGid = resolveCategoryOverrideGid(overrides.category);
    if (categoryGid) {
      mapped.category = categoryGid;
      mapped.graphql.product.category = categoryGid;
    }
  }
  if (overrides.price != null && Number.isFinite(Number(overrides.price)) && Number(overrides.price) > 0) {
    const price = Number(overrides.price);
    mapped.retailPrice = price;
    mapped.graphql.variant.price = String(price.toFixed(2));
    if (mapped.restProduct.product.variants?.[0]) {
      mapped.restProduct.product.variants[0].price = String(price.toFixed(2));
    }
  }

  return mapped;
}

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

const GET_SYNC_LOCKED = `
  query GetSyncLocked($id: ID!) {
    product(id: $id) {
      metafield(namespace: "ociostock", key: "sync_locked") { value }
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
      publishable { availablePublicationsCount { count } }
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

  // API 2025-10: peso vive em inventoryItem.measurement.weight, não num campo
  // flat no variant (confirmado via introspecção do schema real da loja).
  if (v.weight != null && v.weightUnit) {
    variantInput.inventoryItem.measurement = {
      weight: { value: v.weight, unit: v.weightUnit },
    };
  }

  // Pauta aduaneira, quando o fornecedor a envia num formato aproveitável (~90,7%).
  // Omitida em vez de inventada: um código errado numa declaração aduaneira é pior
  // do que campo vazio.
  if (mapped.hsCode) {
    variantInput.inventoryItem.harmonizedSystemCode = mapped.hsCode;
  }

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
 *   stockBuffer?: number,
 * }} params
 */
async function pushInventoryAfterPublish(client, params) {
  const { productId, variantId, inventoryItemId, mapped, locationId, stockBuffer } = params;

  const result = await syncCatalogStockToShopify(client, {
    productId,
    variantId,
    inventoryItemId,
    stock: mapped.stock ?? 0,
    locationId,
    stockBuffer,
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

  const queueEntry = await getCurationQueueEntry(mapped.sku);
  applyManualOverrides(mapped, queueEntry?.metadata?.overrides);

  logShopifyPublishAudit(catalogRow, mapped);

  const existing = await resolveVariantBySku(client, mapped.sku, cache);
  const ctx = { variantCache: cache, locationId: opts.locationId, stockBuffer: opts.stockBuffer };

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
/**
 * Item 15 do roadmap — bloqueio manual de sync por produto. O Carlos põe
 * ociostock.sync_locked=true no Admin da Shopify (metafield boolean, sem UI
 * dedicada por agora) e o publisher deixa de sobrescrever título/vendor/tipo/
 * descrição/tags/categoria/preço/barcode/peso desse produto no ciclo seguinte.
 * Stock continua a sincronizar — não é isso que o Carlos edita à mão.
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} productId
 */
export async function isProductSyncLocked(client, productId) {
  try {
    const data = await client.graphql(GET_SYNC_LOCKED, { id: productId });
    return data.product?.metafield?.value === "true";
  } catch (err) {
    console.warn(`[shopify-publish] Falha ao ler ociostock.sync_locked para ${productId}:`, err?.message || err);
    return false;
  }
}

async function updateExistingProduct(client, mapped, variant, metafieldReady, ctx) {
  const cache = ctx.variantCache || new Map();

  // syncLocked já vem de resolveVariantBySku() (na mesma query que resolveu a
  // variante) — evita uma chamada GraphQL extra por produto que isProductSyncLocked()
  // fazia antes (achado de eficiência no code review, 2026-08-12). undefined (ex: um
  // produto acabado de criar no mesmo run) trata-se como "não trancado", correto por
  // definição para um produto que nunca existiu antes.
  const locked = variant.product?.syncLocked === true;
  if (locked) {
    console.log(`[shopify-publish] ${mapped.sku} bloqueado (ociostock.sync_locked=true) — título/preço/categoria não tocados, stock continua a sincronizar`);
  }

  let inventoryItemId = variant.inventoryItem?.id;

  if (!locked) {
    const input = {
      id: variant.product.id,
      title: mapped.title,
      vendor: mapped.vendor,
      productType: mapped.productType,
      descriptionHtml: mapped.descriptionHtml,
      status: mapped.status,
      tags: mapped.tags,
    };

    // Só inclui `category` se tiver um valor válido — omite se undefined
    if (mapped.category !== undefined) {
      input.category = mapped.category;
    }

    const data = await client.graphql(PRODUCT_UPDATE, { input });
    const errors = data.productUpdate?.userErrors || [];
    if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));

    inventoryItemId = (await applyVariantDetails(client, variant.product.id, variant.id, mapped)) || inventoryItemId;
  }

  if (!inventoryItemId) {
    inventoryItemId = await resolveInventoryItemId(client, mapped.sku, cache);
  }

  if (!locked) {
    await attachMedia(client, variant.product.id, mapped);
  }
  if (metafieldReady) await setProductMetafieldsSafe(client, variant.product.id, mapped);
  await ensurePublishedToOnlineStore(client, variant.product.id);

  if (inventoryItemId) {
    await pushInventoryAfterPublish(client, {
      productId: variant.product.id,
      variantId: variant.id,
      inventoryItemId,
      mapped,
      locationId: ctx.locationId,
      stockBuffer: ctx.stockBuffer,
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

  // Escrever no cache já — resolveVariantBySku tinha guardado "não encontrado" para
  // este SKU mesmo antes de o produto existir (linha 211 em publishCatalogProductToShopify).
  // Sem isto, qualquer chamada seguinte a resolveVariantBySku no mesmo variantCache
  // (retry, resolveInventoryItemId abaixo, ou um SKU repetido na fila) acerta nesse
  // resultado negativo e cria um SEGUNDO produto Shopify para o mesmo SKU.
  cache.set(mapped.sku, {
    id: variantNode.id,
    sku: variantNode.sku || mapped.sku,
    product: { id: created.id, title: created.title },
    inventoryItem: variantNode.inventoryItem || null,
  });

  let inventoryItemId =
    (await applyVariantDetails(client, created.id, variantNode.id, mapped)) ||
    variantNode.inventoryItem?.id;

  if (!inventoryItemId) {
    inventoryItemId = await resolveInventoryItemId(client, mapped.sku, cache);
  }

  await attachMedia(client, created.id, mapped);
  if (metafieldReady) await setProductMetafieldsSafe(client, created.id, mapped);
  await ensurePublishedToOnlineStore(client, created.id);

  if (inventoryItemId) {
    await pushInventoryAfterPublish(client, {
      productId: created.id,
      variantId: variantNode.id,
      inventoryItemId,
      mapped,
      locationId: ctx.locationId,
      stockBuffer: ctx.stockBuffer,
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

/**
 * Publica o produto no canal "Online Store". Lança exceção se falhar — isto garante que
 * o erro é capturado no try/catch da chamadora e registado via markQueueItemSyncError(),
 * em vez de passar silenciosamente como sucesso.
 *
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} productId
 * @throws {Error} se a publicação falhar (userErrors não vazio ou publicação indisponível)
 */
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

    if (!cachedOnlineStorePublicationId) {
      throw new Error("Canal 'Online Store' não encontrado na Shopify — impossível publicar");
    }

    const pubRes = await client.graphql(PUBLISHABLE_PUBLISH, {
      id: productId,
      input: [{ publicationId: cachedOnlineStorePublicationId }],
    });
    const pubErrors = pubRes.publishablePublish?.userErrors || [];
    if (pubErrors.length) {
      throw new Error(`Falha ao publicar no Online Store: ${pubErrors.map((e) => e.message).join("; ")}`);
    }

    console.log(`[shopify-publish] Produto ${productId} publicado no Online Store: ${cachedOnlineStorePublicationId}`);
  } catch (err) {
    // Propaga o erro para que seja capturado em publishCatalogProductToShopify() e
    // eventualmente registado via markQueueItemSyncError() em shopifyApprovedSync.server.js
    throw new Error(`[publicação-online-store] ${err?.message || String(err)}`);
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
/**
 * Escreve os metafields do produto sem nunca derrubar a publicação.
 *
 * Um metafield é enriquecimento, não parte essencial do produto: se falhar, o título,
 * preço, imagens e stock já foram (ou vão ser) publicados na mesma. Antes deste wrapper
 * uma exceção em metafieldsSet abortava o produto inteiro a meio.
 *
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} productId
 * @param {{ sku?: string, netPrice?: number|null, dimensions?: string|null }} mapped
 */
async function setProductMetafieldsSafe(client, productId, mapped) {
  const sku = mapped?.sku || "(sem sku)";
  try {
    await setNetPriceMetafield(client, productId, mapped.netPrice);
  } catch (err) {
    console.warn(`[shopify-publish] metafield net_price falhou para ${sku}:`, err?.message || err);
  }
  try {
    await setDimensionsMetafield(client, productId, mapped.dimensions);
  } catch (err) {
    console.warn(`[shopify-publish] metafield dimensions falhou para ${sku}:`, err?.message || err);
  }
  try {
    await setBrandMetafield(client, productId, mapped.vendor);
  } catch (err) {
    console.warn(`[shopify-publish] metafield brand falhou para ${sku}:`, err?.message || err);
  }
  try {
    await setLicenceMetafield(client, productId, mapped.franchises?.[0]);
  } catch (err) {
    console.warn(`[shopify-publish] metafield licence falhou para ${sku}:`, err?.message || err);
  }
}

/**
 * Licença primária (1.ª franchise) — alimenta as smart collections automáticas por
 * licença (item 5, ver autoCollections.server.js). Mesma convenção das outras: sem
 * franchise não grava string vazia.
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} productId
 * @param {string|null|undefined} licence
 */
async function setLicenceMetafield(client, productId, licence) {
  const value = String(licence || "").trim();
  if (!value) return;

  const data = await client.graphql(METAFIELDS_SET, {
    metafields: [
      {
        ownerId: productId,
        namespace: "ociostock",
        key: "licence",
        type: "single_line_text_field",
        value,
      },
    ],
  });
  const errors = data.metafieldsSet?.userErrors || [];
  if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
}

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

/**
 * Dimensões da embalagem em ociostock.dimensions (single_line_text_field), mesmo
 * namespace do ociostock.net_price já existente.
 * Ausentes em ~31% do catálogo — nesses casos NÃO escreve o metafield, em vez de
 * gravar string vazia: um metafield vazio apareceria na Shopify e no tema como campo
 * existente mas sem valor, que é pior do que não existir.
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} productId
 * @param {string|null|undefined} dimensions
 */
async function setDimensionsMetafield(client, productId, dimensions) {
  const value = String(dimensions || "").trim();
  if (!value) return;

  const data = await client.graphql(METAFIELDS_SET, {
    metafields: [
      {
        ownerId: productId,
        namespace: "ociostock",
        key: "dimensions",
        type: "single_line_text_field",
        value,
      },
    ],
  });
  const errors = data.metafieldsSet?.userErrors || [];
  if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
}

/**
 * Marca (vendor) como metafield estruturado, mesmo namespace `ociostock` dos outros.
 * Ausente quando o fornecedor não envia marca — não grava string vazia (mesma
 * convenção de setDimensionsMetafield).
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} productId
 * @param {string|null|undefined} vendor
 */
async function setBrandMetafield(client, productId, vendor) {
  const value = String(vendor || "").trim();
  if (!value) return;

  const data = await client.graphql(METAFIELDS_SET, {
    metafields: [
      {
        ownerId: productId,
        namespace: "ociostock",
        key: "brand",
        type: "single_line_text_field",
        value,
      },
    ],
  });
  const errors = data.metafieldsSet?.userErrors || [];
  if (errors.length) throw new Error(errors.map((e) => e.message).join("; "));
}
