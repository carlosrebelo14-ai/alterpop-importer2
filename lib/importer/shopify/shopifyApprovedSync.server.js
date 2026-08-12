import { prisma, safePrisma } from "../../prisma/prismaSafe.server.js";
import {
  listCurationQueueItems,
  markQueueItemPublished,
  markQueueItemSyncError,
} from "../../curation/curationQueue.server.js";
import { createShopifyClientFromSession } from "../shopifyClient.js";
import {
  isShopifyAuthError,
  isShopifySessionError,
  loadOfflineSessionForShop,
  ShopifyAuthSessionError,
} from "../../session/loadOfflineSessionForShop.server.js";
import {
  clearSyncErrorForSku,
  persistSyncError,
} from "../sync/syncErrorLog.server.js";
import { publishCatalogProductToShopify } from "./shopifyProductPublisher.server.js";
import { ensureOciostockMetafieldDefinitions } from "./metafieldSetup.js";
import {
  completeShopifySyncJob,
  failShopifySyncJob,
  initShopifySyncJob,
  updateShopifySyncProgress,
  isShopifySyncCancelled,
} from "./shopifySyncJob.server.js";
import { createSyncJobRecord, finishSyncJobRecord } from "./syncJobHistory.server.js";
import { loadShopSettings } from "../settings.server.js";

const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Aceita Location GID completo ou ID numérico.
 * @param {string | undefined | null} rawLocationId
 */
function normalizeLocationId(rawLocationId) {
  const value = String(rawLocationId || "").trim();
  if (!value) return undefined;
  if (value.startsWith("gid://shopify/Location/")) return value;
  if (/^\d+$/.test(value)) return `gid://shopify/Location/${value}`;
  return value;
}

/**
 * @param {string} shop
 * @param {string[]} skus
 */
async function loadCatalogRowsBySkus(shop, skus) {
  if (!skus.length) return [];
  return safePrisma("shopifySync.catalogProducts", () =>
    prisma.catalogProduct.findMany({
      where: { shop, sku: { in: skus } },
    })
  );
}

/**
 * Motor de publicação — lotes de 10, 1s entre lotes, nunca interrompe o job inteiro.
 * @param {{ shop: string, accessToken: string }} session
 */
/**
 * @param {{ shop: string, accessToken: string }} session
 * @param {{ skipInit?: boolean, customTags?: string[], skus?: string[] }} [opts]
 */
export async function runApprovedShopifySync(session, opts = {}) {
  const shop = session.shop;
  const approved = (await listCurationQueueItems("APPROVED")).map((i) => i.sku);
  let uniqueSkus = [...new Set(approved)];

  if (Array.isArray(opts.skus) && opts.skus.length > 0) {
    const requestedSet = new Set(opts.skus);
    uniqueSkus = uniqueSkus.filter((sku) => requestedSet.has(sku));
    if (!uniqueSkus.length) {
      // Allow syncing requested SKUs even if status wasn't set to APPROVED yet
      uniqueSkus = [...requestedSet];
    }
  }

  if (!uniqueSkus.length) {
    return { ok: false, error: "Nenhum produto com status APPROVED na fila de curadoria." };
  }

  const catalogRows = await loadCatalogRowsBySkus(shop, uniqueSkus);
  const rowBySku = new Map(catalogRows.map((r) => [r.sku, r]));

  const work = uniqueSkus.map((sku) => ({
    sku,
    row: rowBySku.get(sku) || null,
  }));

  if (!opts.skipInit) {
    await initShopifySyncJob(shop, work.length);
  }

  // Histórico persistido (item 16) — independente do jobId de shopifySyncJob.server.js
  // (que às vezes nem chega a ser criado no caminho do relógio, ver skipInit sempre
  // true em startApprovedShopifySyncInBackground). Gerado sempre, mesmo com skipInit,
  // para toda corrida ficar registada e os erros individuais poderem referenciá-la.
  const syncHistoryJobId = `syncjob_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await createSyncJobRecord(syncHistoryJobId, shop, work.length);

  let offlineSession;
  try {
    offlineSession = await loadOfflineSessionForShop(shop);
  } catch (err) {
    const message =
      err instanceof ShopifyAuthSessionError
        ? err.message
        : "Autenticação Shopify inválida. Abre a app no Admin.";
    await failShopifySyncJob(shop, message);
    await finishSyncJobRecord(syncHistoryJobId, { succeeded: 0, failed: 0, status: "failed" });
    throw err;
  }

  const client = createShopifyClientFromSession(offlineSession);
  const shopSettings = await loadShopSettings(shop);
  const locationId = normalizeLocationId(
    shopSettings.locationId?.trim() || process.env.SHOPIFY_LOCATION_ID?.trim() || undefined
  );
  const variantCache = new Map();

  // Estava hardcoded a `false`, o que silenciosamente impedia QUALQUER escrita de
  // metafield por este caminho (o publisher tem `if (metafieldReady)`) — nem o
  // ociostock.net_price, que existe desde o início, nem o ociostock.dimensions.
  // Bug encontrado a 2026-08-05. Falha aqui não impede o publish: sem definições
  // os produtos vão na mesma, apenas sem metafields.
  let metafieldReady = false;
  try {
    metafieldReady = await ensureOciostockMetafieldDefinitions(client, null);
  } catch (err) {
    console.warn(
      "[shopify-sync] definições de metafield indisponíveis, publish continua sem elas:",
      err?.message || err
    );
  }

  let published = 0;
  let failed = 0;
  let processed = 0;
  /** @type {{ sku: string, message: string }[]} */
  const recentErrors = [];

  try {
    for (let i = 0; i < work.length; i += BATCH_SIZE) {
      if (isShopifySyncCancelled(shop)) {
        console.log(`[shopifySync] Sync cancelado pelo utilizador para ${shop}.`);
        break;
      }

      const batch = work.slice(i, i + BATCH_SIZE);

      for (const item of batch) {
        if (isShopifySyncCancelled(shop)) break;

        processed += 1;
        await updateShopifySyncProgress(shop, {
          processed,
          published,
          failed,
          currentSku: item.sku,
          recentErrors: recentErrors.slice(-20),
        });

        if (!item.row) {
          failed += 1;
          const message = "SKU não encontrado no catálogo indexado (SQLite)";
          recentErrors.push({ sku: item.sku, message });
          await markQueueItemSyncError(item.sku, message);
          await persistSyncError({
            shop,
            sku: item.sku,
            reason: message,
            type: "validation",
            jobId: syncHistoryJobId,
          });
          continue;
        }

        try {
          const result = await publishCatalogProductToShopify(client, item.row, {
            variantCache,
            metafieldReady,
            locationId,
            customTags: opts.customTags,
            stockBuffer: shopSettings.stockBuffer,
          });

          await markQueueItemPublished(item.sku, result.shopifyProductId);
          await clearSyncErrorForSku(shop, item.sku);
          published += 1;
        } catch (err) {
          failed += 1;
          let message = err?.message || String(err);

          // Só sessão inválida/expirada justifica retry — scope em falta não desaparece
          // recarregando a sessão, e repetir cegamente aqui reusa o variantCache já
          // "envenenado" com o resultado negativo da procura anterior, criando um
          // segundo produto Shopify para o mesmo SKU.
          if (isShopifySessionError(err) && offlineSession) {
            try {
              offlineSession = await loadOfflineSessionForShop(shop);
              const retryClient = createShopifyClientFromSession(offlineSession);
              const result = await publishCatalogProductToShopify(
                retryClient,
                item.row,
                { variantCache, metafieldReady, locationId, stockBuffer: shopSettings.stockBuffer }
              );
              await markQueueItemPublished(item.sku, result.shopifyProductId);
              await clearSyncErrorForSku(shop, item.sku);
              published += 1;
              failed -= 1;
              recentErrors.pop();
              continue;
            } catch (retryErr) {
              message = retryErr?.message || message;
            }
          }

          recentErrors.push({ sku: item.sku, message });
          await markQueueItemSyncError(item.sku, message);
          await persistSyncError({
            shop,
            sku: item.sku,
            reason: message,
            type: isShopifyAuthError(err) ? "auth" : "product",
            jobId: syncHistoryJobId,
          });
          console.error(`[shopify-sync] Falha SKU ${item.sku}:`, message);

          if (isShopifyAuthError(err)) {
            await failShopifySyncJob(
              shop,
              `${message} Reabre a app no Admin Shopify e volta a publicar.`
            );
            break;
          }
        }
      }

      if (i + BATCH_SIZE < work.length) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    const status = await completeShopifySyncJob(shop, {
      published,
      failed,
      recentErrors: recentErrors.slice(-50),
    });

    await finishSyncJobRecord(syncHistoryJobId, {
      succeeded: published,
      failed,
      status: "completed",
    });

    return {
      ok: true,
      jobId: status.jobId,
      total: work.length,
      published,
      failed,
      recentErrors: status.recentErrors,
    };
  } catch (err) {
    await failShopifySyncJob(shop, err?.message || String(err));
    await finishSyncJobRecord(syncHistoryJobId, {
      succeeded: published,
      failed,
      status: "failed",
    });
    throw err;
  }
}

/**
 * @param {{ shop: string, accessToken: string }} session
 * @param {{ customTags?: string[] }} [opts]
 */
export function startApprovedShopifySyncInBackground(session, opts = {}) {
  setImmediate(() => {
    runApprovedShopifySync(session, { skipInit: true, customTags: opts.customTags, skus: opts.skus }).catch((err) => {
      console.error("[shopify-sync] Job fatal:", err?.message || err);
    });
  });
}
