import { loadCurationQueue, saveCurationQueue } from "../../curation/curationQueue.server.js";
import { createShopifyClientFromSession } from "../shopifyClient.js";
import {
  isShopifyAuthError,
  loadOfflineSessionForShop,
  ShopifyAuthSessionError,
} from "../../session/loadOfflineSessionForShop.server.js";
import {
  completeShopifyResetJob,
  failShopifyResetJob,
  initShopifyResetJob,
  updateShopifyResetProgress,
} from "./shopifyResetJob.server.js";
import { ALTERPOP_APP_TAGS } from "./shopifyMapper.server.js";

const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 1000;

const ALL_PRODUCTS = `
  query AllShopProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        tags
        variants(first: 5) {
          nodes {
            sku
          }
        }
      }
    }
  }
`;

const PRODUCTS_BY_TAG = `
  query AlterpopProductsByTag($query: String!, $first: Int!, $after: String) {
    products(first: $first, after: $after, query: $query) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
        tags
        variants(first: 3) {
          nodes {
            sku
          }
        }
      }
    }
  }
`;

const PRODUCT_DELETE = `
  mutation ProductDelete($input: ProductDeleteInput!) {
    productDelete(input: $input) {
      deletedProductId
      userErrors {
        field
        message
      }
    }
  }
`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const PRODUCTS_COUNT = `
  query ShopifyProductsCount {
    productsCount {
      count
    }
  }
`;

/**
 * Contagem rápida de produtos na loja (pré-visualização no modal).
 * @param {{ shop: string, accessToken: string }} session
 */
export async function countShopifyProductsForReset(session) {
  const offline = await loadOfflineSessionForShop(session.shop);
  const client = createShopifyClientFromSession(offline);
  const data = await client.graphql(PRODUCTS_COUNT);
  return Number(data.productsCount?.count) || 0;
}

/**
 * Lista TODOS os produtos da loja (paginação GraphQL).
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {(count: number) => void} [onPage]
 */
async function listAllShopifyProducts(client, onPage) {
  /** @type {Map<string, { id: string, title: string, sku: string|null, tags: string[] }>} */
  const byId = new Map();
  let cursor = null;

  do {
    const data = await client.graphql(ALL_PRODUCTS, {
      first: 250,
      after: cursor,
    });

    for (const node of data.products?.nodes || []) {
      const sku =
        node.variants?.nodes?.find((v) => v?.sku)?.sku ||
        node.variants?.nodes?.[0]?.sku ||
        null;
      byId.set(node.id, {
        id: node.id,
        title: node.title || node.id,
        sku,
        tags: node.tags || [],
      });
    }

    const pageInfo = data.products?.pageInfo;
    cursor = pageInfo?.hasNextPage ? pageInfo.endCursor : null;
    onPage?.(byId.size);
  } while (cursor);

  return [...byId.values()];
}

/**
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} tag
 */
async function listProductsWithTag(client, tag) {
  /** @type {Map<string, { id: string, title: string, sku: string|null, tags: string[] }>} */
  const byId = new Map();
  let cursor = null;

  do {
    const safeTag = String(tag || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const data = await client.graphql(PRODUCTS_BY_TAG, {
      query: `tag:"${safeTag}"`,
      first: 100,
      after: cursor,
    });

    for (const node of data.products?.nodes || []) {
      const sku =
        node.variants?.nodes?.find((v) => v?.sku)?.sku ||
        node.variants?.nodes?.[0]?.sku ||
        null;
      byId.set(node.id, {
        id: node.id,
        title: node.title || node.id,
        sku,
        tags: node.tags || [],
      });
    }

    const pageInfo = data.products?.pageInfo;
    cursor = pageInfo?.hasNextPage ? pageInfo.endCursor : null;
  } while (cursor);

  return [...byId.values()];
}

/**
 * Produtos conhecidos pela fila local (PUBLISHED / SYNC_ERROR com GID Shopify).
 */
async function listProductsFromCurationQueue() {
  const queue = await loadCurationQueue();
  /** @type {Map<string, { id: string, title: string, sku: string|null }>} */
  const byId = new Map();

  for (const item of queue.items) {
    const productId = item.metadata?.shopifyProductId;
    if (!productId) continue;
    if (item.status !== "PUBLISHED" && item.status !== "SYNC_ERROR") continue;
    byId.set(String(productId), {
      id: String(productId),
      title: item.title_en || item.sku,
      sku: item.sku,
    });
  }

  return [...byId.values()];
}

/**
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} productId
 */
async function deleteShopifyProduct(client, productId) {
  const data = await client.graphql(PRODUCT_DELETE, {
    input: { id: productId },
  });
  const errors = data.productDelete?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }
  return data.productDelete?.deletedProductId || productId;
}

/**
 * Repõe toda a fila local publicada para APPROVED (reset completo da loja).
 */
export async function revertAllPublishedInQueue() {
  const queue = await loadCurationQueue();
  let reverted = 0;

  for (const item of queue.items) {
    const pid = item.metadata?.shopifyProductId;
    if (item.status !== "PUBLISHED" && item.status !== "SYNC_ERROR" && !pid) {
      continue;
    }

    item.status = "APPROVED";
    item.shopifyStatus = "ACTIVE";
    item.metadata = {
      ...item.metadata,
      shopifyProductId: null,
      publishedAt: null,
      shopifyResetAt: new Date().toISOString(),
      syncError: null,
      syncErrorAt: null,
    };
    reverted += 1;
  }

  if (reverted > 0) {
    await saveCurationQueue(queue);
  }

  return reverted;
}

/**
 * Reverte PUBLISHED → APPROVED e limpa shopify_product_id.
 * @param {string[]} skus
 * @param {string[]} productIds
 */
export async function revertLocalAfterShopifyReset(skus = [], productIds = []) {
  const queue = await loadCurationQueue();
  const skuSet = new Set(skus.filter(Boolean));
  const idSet = new Set(productIds.filter(Boolean));
  let reverted = 0;

  for (const item of queue.items) {
    const pid = item.metadata?.shopifyProductId;
    const match = skuSet.has(item.sku) || (pid && idSet.has(String(pid)));
    if (!match) continue;
    if (item.status !== "PUBLISHED" && item.status !== "SYNC_ERROR" && !pid) {
      continue;
    }

    item.status = "APPROVED";
    item.shopifyStatus = "ACTIVE";
    item.metadata = {
      ...item.metadata,
      shopifyProductId: null,
      publishedAt: null,
      shopifyResetAt: new Date().toISOString(),
      syncError: null,
      syncErrorAt: null,
    };
    reverted += 1;
  }

  if (reverted > 0) {
    await saveCurationQueue(queue);
  }

  return reverted;
}

/**
 * Lista produtos a apagar no reset de emergência.
 * Por defeito: TODOS os produtos da loja Shopify (não só tags alterpop).
 * @param {{ shop: string, accessToken: string }} session
 * @param {{ scope?: 'all' | 'app_tags' }} [opts]
 */
export async function collectProductsForShopifyReset(session, opts = {}) {
  const scope = opts.scope || "all";
  const onListProgress = opts.onListProgress;
  const offline = await loadOfflineSessionForShop(session.shop);
  const client = createShopifyClientFromSession(offline);

  /** @type {Map<string, { id: string, title: string, sku: string|null, tags?: string[] }>} */
  const merged = new Map();

  if (scope === "all") {
    const all = await listAllShopifyProducts(client, (count) => {
      onListProgress?.(count);
    });
    for (const p of all) merged.set(p.id, p);
    console.log(`[shopify-reset] ${merged.size} produto(s) na loja Shopify.`);
  } else {
    for (const tag of ALTERPOP_APP_TAGS) {
      const tagged = await listProductsWithTag(client, tag);
      for (const p of tagged) merged.set(p.id, p);
    }
  }

  for (const p of await listProductsFromCurationQueue()) {
    merged.set(p.id, p);
  }

  return {
    client,
    products: [...merged.values()],
    scope,
  };
}

/** @deprecated Use collectProductsForShopifyReset */
export const collectAlterpopShopifyProducts = collectProductsForShopifyReset;

/**
 * Apaga em lotes de 20 com delay; reverte estado local após cada sucesso.
 * @param {{ shop: string, accessToken: string }} session
 * @param {{ skipInit?: boolean }} [opts]
 */
export async function runShopifyCatalogReset(session, opts = {}) {
  const shop = session.shop;

  if (!opts.skipInit) {
    await initShopifyResetJob(shop);
  }

  let deleted = 0;
  let failed = 0;
  let processed = 0;
  let revertedLocal = 0;
  /** @type {{ productId: string, message: string }[]} */
  const recentErrors = [];

  try {
    await updateShopifyResetProgress(shop, { state: "listing", currentTitle: "A listar…" });

    const { client, products } = await collectProductsForShopifyReset(session, {
      scope: "all",
      onListProgress: (count) => {
        updateShopifyResetProgress(shop, {
          state: "listing",
          total: count,
          processed: 0,
          currentTitle: `A listar… ${count} produto(s)`,
        }).catch(() => {});
      },
    });
    const total = products.length;

    if (total === 0) {
      await completeShopifyResetJob(shop, {
        deleted: 0,
        failed: 0,
        revertedLocal: 0,
        recentErrors: [],
      });
      return { ok: true, total: 0, deleted: 0, failed: 0, revertedLocal: 0 };
    }

    await updateShopifyResetProgress(shop, {
      state: "deleting",
      total,
      processed: 0,
      deleted: 0,
      failed: 0,
    });

    console.log(`[shopify-reset] A apagar ${total} produto(s) na Shopify (catálogo completo)…`);

    for (let i = 0; i < products.length; i += BATCH_SIZE) {
      const batch = products.slice(i, i + BATCH_SIZE);

      for (const product of batch) {
        processed += 1;
        await updateShopifyResetProgress(shop, {
          state: "deleting",
          total,
          processed,
          deleted,
          failed,
          revertedLocal,
          currentTitle: product.title,
          recentErrors: recentErrors.slice(-20),
        });

        try {
          await deleteShopifyProduct(client, product.id);
          const reverted = await revertLocalAfterShopifyReset(
            product.sku ? [product.sku] : [],
            [product.id]
          );
          revertedLocal += reverted;
          deleted += 1;
        } catch (err) {
          failed += 1;
          const message = err?.message || String(err);
          recentErrors.push({ productId: product.id, message });
          console.error(`[shopify-reset] Falha ${product.id}:`, message);

          if (isShopifyAuthError(err)) {
            await failShopifyResetJob(
              shop,
              `${message} Reabre a app no Admin e tenta novamente.`
            );
            throw err;
          }
        }
      }

      if (i + BATCH_SIZE < products.length) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    revertedLocal = await revertAllPublishedInQueue();

    await completeShopifyResetJob(shop, {
      deleted,
      failed,
      revertedLocal,
      recentErrors: recentErrors.slice(-50),
    });

    console.log(
      `[shopify-reset] Concluído: ${deleted} apagado(s), ${failed} falha(s), ${revertedLocal} revertido(s) na fila local.`
    );

    return { ok: true, total, deleted, failed, revertedLocal };
  } catch (err) {
    if (!(err instanceof ShopifyAuthSessionError)) {
      await failShopifyResetJob(shop, err?.message || String(err));
    }
    throw err;
  }
}

/**
 * @param {{ shop: string, accessToken: string }} session
 */
export function startShopifyCatalogResetInBackground(session) {
  setImmediate(() => {
    runShopifyCatalogReset(session, { skipInit: true }).catch((err) => {
      console.error("[shopify-reset] Job fatal:", err?.message || err);
    });
  });
}
