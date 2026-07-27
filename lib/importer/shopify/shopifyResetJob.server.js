import fs from "fs/promises";
import path from "path";
import { getDefaultConfig } from "../config.js";

/** @typedef {'idle'|'running'|'listing'|'deleting'|'completed'|'failed'} ShopifyResetJobState */

/**
 * @typedef {object} ShopifyResetJobStatus
 * @property {string|null} jobId
 * @property {string} shop
 * @property {ShopifyResetJobState} state
 * @property {number} total
 * @property {number} processed
 * @property {number} deleted
 * @property {number} failed
 * @property {number} revertedLocal
 * @property {string|null} currentTitle
 * @property {string|null} error
 * @property {string|null} startedAt
 * @property {string|null} finishedAt
 * @property {{ productId: string, message: string }[]} recentErrors
 */

function statusPath(shop) {
  return path.join(
    getDefaultConfig().paths.data,
    "shopify-reset",
    `${shop.replace(/\//g, "_")}-status.json`
  );
}

/**
 * @param {string} shop
 */
export async function readShopifyResetStatus(shop) {
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
      deleted: 0,
      failed: 0,
      revertedLocal: 0,
      currentTitle: null,
      error: null,
      startedAt: null,
      finishedAt: null,
      recentErrors: [],
    };
  }
}

/**
 * @param {string} shop
 * @param {Partial<ShopifyResetJobStatus>} patch
 */
export async function writeShopifyResetStatus(shop, patch) {
  await fs.mkdir(path.dirname(statusPath(shop)), { recursive: true });
  const prev = await readShopifyResetStatus(shop);
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
export async function isShopifyResetRunning(shop) {
  const status = await readShopifyResetStatus(shop);
  return status.state === "running" || status.state === "listing" || status.state === "deleting";
}

/**
 * @param {string} shop
 */
export async function initShopifyResetJob(shop) {
  const jobId = `shopify-reset-${Date.now()}`;
  return writeShopifyResetStatus(shop, {
    jobId,
    state: "running",
    total: 0,
    processed: 0,
    deleted: 0,
    failed: 0,
    revertedLocal: 0,
    currentTitle: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    recentErrors: [],
  });
}

/**
 * @param {string} shop
 * @param {Partial<ShopifyResetJobStatus>} progress
 */
export async function updateShopifyResetProgress(shop, progress) {
  return writeShopifyResetStatus(shop, progress);
}

/**
 * @param {string} shop
 * @param {{ deleted: number, failed: number, revertedLocal: number, recentErrors?: object[] }} summary
 */
export async function completeShopifyResetJob(shop, summary) {
  return writeShopifyResetStatus(shop, {
    state: "completed",
    processed: summary.deleted + summary.failed,
    deleted: summary.deleted,
    failed: summary.failed,
    revertedLocal: summary.revertedLocal,
    currentTitle: null,
    finishedAt: new Date().toISOString(),
    recentErrors: summary.recentErrors || [],
  });
}

/**
 * @param {string} shop
 * @param {string} error
 */
export async function failShopifyResetJob(shop, error) {
  return writeShopifyResetStatus(shop, {
    state: "failed",
    error: String(error).slice(0, 2000),
    currentTitle: null,
    finishedAt: new Date().toISOString(),
  });
}
