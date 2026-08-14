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
    // Última escrita real — usado por isShopifySyncRunning para distinguir um job
    // parado (processo morto, sem escrever há minutos) de um job só lento (milhares
    // de produtos, escreve a cada item mas demora horas no total). Ver histórico:
    // o campo antigo só media startedAt, por isso qualquer sync com mais de 3 min de
    // duração TOTAL era morta como "inativa", mesmo a meio de progresso real.
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(statusPath(shop), JSON.stringify(next, null, 2), "utf8");
  return next;
}

/**
 * @param {string} shop
 */
// Limiar de inatividade REAL — tempo sem nenhuma escrita de progresso, não tempo
// total de execução. Uma sincronização de milhares de produtos demora legitimamente
// horas; o que indica um processo morto é não escrever progresso há vários minutos.
const STALE_INACTIVITY_MS = 10 * 60 * 1000;

export async function isShopifySyncRunning(shop) {
  const status = await readShopifySyncStatus(shop);
  if (status.state !== "running") return false;

  // Stale lock cleanup: liberta o lock só se não há escrita de progresso há
  // STALE_INACTIVITY_MS — não pelo tempo total desde que o job começou.
  const lastActivity = status.updatedAt || status.startedAt;
  if (lastActivity) {
    const inactiveFor = Date.now() - new Date(lastActivity).getTime();
    if (inactiveFor > STALE_INACTIVITY_MS) {
      await failShopifySyncJob(shop, "Sincronização anterior expirou por inatividade.");
      return false;
    }
  } else {
    await failShopifySyncJob(shop, "Sincronização anterior sem estado válido.");
    return false;
  }

  return true;
}

/** @type {Set<string>} */
const cancelledShops = new Set();

/**
 * @param {string} shop
 */
export function isShopifySyncCancelled(shop) {
  return cancelledShops.has(shop);
}

/**
 * @param {string} shop
 * @param {number} total
 */
export async function initShopifySyncJob(shop, total) {
  cancelledShops.delete(shop);
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
  cancelledShops.delete(shop);
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
  cancelledShops.delete(shop);
  return writeShopifySyncStatus(shop, {
    state: "failed",
    error: String(error).slice(0, 2000),
    currentSku: null,
    finishedAt: new Date().toISOString(),
  });
}

/**
 * Cancela/Interrompe o job de sincronização em curso.
 * @param {string} shop
 */
export async function cancelShopifySyncJob(shop) {
  cancelledShops.add(shop);
  const prev = await readShopifySyncStatus(shop);
  return writeShopifySyncStatus(shop, {
    state: "failed",
    error: "Importação cancelada pelo utilizador.",
    currentSku: null,
    finishedAt: new Date().toISOString(),
    recentErrors: [
      ...(prev.recentErrors || []),
      { sku: prev.currentSku || "SYSTEM", message: "Importação interrompida a pedido do utilizador." },
    ],
  });
}
