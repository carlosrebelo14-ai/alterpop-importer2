import fs from "fs/promises";
import path from "path";
import { getDefaultConfig } from "../config.js";

/** @typedef {'idle'|'running'|'completed'|'failed'} ShopifySyncJobState */

/**
 * @typedef {object} ShopifySyncJobStatus
 * @property {string} jobId
 * @property {string} shop
 * @property {ShopifySyncJobState} state
 * @property {number} total
 * @property {number} processed
 * @property {number} published
 * @property {number} failed
 * @property {string|null} currentSku
 * @property {string|null} error
 * @property {string|null} startedAt
 * @property {string|null} finishedAt
 * @property {{ sku: string, message: string }[]} recentErrors
 */

function statusPath(shop) {
  return path.join(
    getDefaultConfig().paths.data,
    "shopify-sync",
    `${shop.replace(/\//g, "_")}-status.json`
  );
}

/**
 * @param {string} shop
 */
export async function readShopifySyncStatus(shop) {
  try {
    const raw = await fs.readFile(statusPath(shop), "utf8");
    return JSON.parse(raw);
  } catch {
    return {
      jobId: null,
      shop,
      state: "idle",
      total: 0,
      processed: 0,
      published: 0,
      failed: 0,
      currentSku: null,
      error: null,
      startedAt: null,
      finishedAt: null,
      recentErrors: [],
    };
  }
}

/**
 * @param {string} shop
 * @param {Partial<ShopifySyncJobStatus>} patch
 */
export async function writeShopifySyncStatus(shop, patch) {
  await fs.mkdir(path.dirname(statusPath(shop)), { recursive: true });
  const prev = await readShopifySyncStatus(shop);
  const next = {
    ...prev,
    shop,
    ...patch,
    recentErrors: patch.recentErrors ?? prev.recentErrors ?? [],
  };
  await fs.writeFile(statusPath(shop), JSON.stringify(next, null, 2), "utf8");
  return next;
}

/**
 * @param {string} shop
 */
export async function isShopifySyncRunning(shop) {
  const status = await readShopifySyncStatus(shop);
  if (status.state !== "running") return false;

  // Stale lock cleanup: if running for > 3 minutes (or missing startedAt), release lock
  if (status.startedAt) {
    const elapsed = Date.now() - new Date(status.startedAt).getTime();
    if (elapsed > 3 * 60 * 1000) {
      await failShopifySyncJob(shop, "Sincronização anterior expirou por inatividade.");
      return false;
    }
  } else {
    await failShopifySyncJob(shop, "Sincronização anterior sem estado válido.");
    return false;
  }

  return true;
}

/**
 * @param {string} shop
 * @param {number} total
 */
export async function initShopifySyncJob(shop, total) {
  const jobId = `shopify-sync-${Date.now()}`;
  return writeShopifySyncStatus(shop, {
    jobId,
    state: "running",
    total,
    processed: 0,
    published: 0,
    failed: 0,
    currentSku: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    recentErrors: [],
  });
}

/**
 * @param {string} shop
 * @param {{ processed: number, published: number, failed: number, currentSku?: string|null, recentErrors?: object[] }} progress
 */
export async function updateShopifySyncProgress(shop, progress) {
  return writeShopifySyncStatus(shop, progress);
}

/**
 * @param {string} shop
 * @param {{ published: number, failed: number, recentErrors?: object[] }} summary
 */
export async function completeShopifySyncJob(shop, summary) {
  return writeShopifySyncStatus(shop, {
    state: "completed",
    processed: summary.published + summary.failed,
    published: summary.published,
    failed: summary.failed,
    currentSku: null,
    finishedAt: new Date().toISOString(),
    recentErrors: summary.recentErrors || [],
  });
}

/**
 * @param {string} shop
 * @param {string} error
 */
export async function failShopifySyncJob(shop, error) {
  return writeShopifySyncStatus(shop, {
    state: "failed",
    error: String(error).slice(0, 2000),
    currentSku: null,
    finishedAt: new Date().toISOString(),
  });
}
