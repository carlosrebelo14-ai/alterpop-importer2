import fs from "fs/promises";
import path from "path";
import { prisma, safePrisma } from "../../prisma/prismaSafe.server.js";
import { getDefaultConfig } from "../config.js";
import { loadCuration, normalizeForMatch, clearCurationCache } from "./loadCuration.js";
import { evaluateStructuredCatalogFilter } from "./structuredCatalogFilter.server.js";
import { catalogRowToEvaluateRecord } from "../catalog/purgeDatabase.server.js";
import { getCatalogProductTotal } from "../catalog/catalogProductsDb.server.js";

const SCAN_BATCH = 500;
const DELETE_BATCH = 200;

/**
 * Marca premium (match parcial no vendor).
 * @param {import('../types.js').ProductRecord} record
 * @param {ReturnType<typeof loadCuration>} rules
 */
export function isPremiumBrand(record, rules) {
  const vendor = normalizeForMatch(record.vendor);
  if (!vendor) return false;

  for (const brandNorm of rules.premiumBrandsNorm) {
    if (!brandNorm) continue;
    const brandAscii = brandNorm.normalize("NFD").replace(/\p{M}/gu, "");
    const vendorAscii = vendor.normalize("NFD").replace(/\p{M}/gu, "");
    if (
      vendor === brandNorm ||
      vendor.includes(brandNorm) ||
      brandNorm.includes(vendor) ||
      vendorAscii.includes(brandAscii) ||
      brandAscii.includes(vendorAscii)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Curadoria de Elite — precedência sobre smart rules e IA (nunca auto-aprova fora da lista).
 * @param {import('../types.js').ProductRecord} record
 * @returns {{ action: 'AUTO_REJECT' | 'PENDING_MANUAL' | null, reasons: string[] }}
 */
export function evaluateEliteCuration(record) {
  const structured = evaluateStructuredCatalogFilter(record);
  if (structured.fastTrack) {
    return { action: null, reasons: [structured.reason || "structured_fast_track"] };
  }

  if (structured.excluded) {
    return {
      action: "AUTO_REJECT",
      reasons: [structured.reason || "structured_reject"],
    };
  }

  const rules = loadCuration();
  if (!isPremiumBrand(record, rules)) {
    return {
      action: "PENDING_MANUAL",
      reasons: ["elite_brand_not_premium"],
    };
  }

  return { action: null, reasons: [] };
}

/**
 * Produto deve sair do catálogo na limpeza elite.
 * @param {import('../types.js').ProductRecord} record
 */
export function shouldPurgeEliteProduct(record) {
  const elite = evaluateEliteCuration(record);
  return elite.action === "AUTO_REJECT" || elite.action === "PENDING_MANUAL";
}

function elitePurgeLogPath(shop) {
  return path.join(
    getDefaultConfig().paths.data,
    "catalog-index",
    `${shop.replace(/\//g, "_")}-elite-purge-log.json`
  );
}

/**
 * Remove da base de dados produtos que não passam na Curadoria de Elite.
 * @param {string} shop
 */
export async function purgeEliteCatalog(shop) {
  clearCurationCache();

  const before = await getCatalogProductTotal(shop);
  if (before === 0) {
    const message =
      "Curadoria de Elite: 0 produtos removidos. Catálogo já estava vazio.";
    return { before: 0, removed: 0, remaining: 0, message, byReason: {} };
  }

  /** @type {Record<string, number>} */
  const byReason = {};
  let removed = 0;
  /** @type {string | null} */
  let cursor = null;

  for (;;) {
    const batch = await safePrisma("catalogProduct.findMany.elitePurge", () =>
      prisma.catalogProduct.findMany({
        where: {
          shop,
          ...(cursor ? { sku: { gt: cursor } } : {}),
        },
        take: SCAN_BATCH,
        orderBy: { sku: "asc" },
      }),
      { fallback: [] }
    );

    if (!batch.length) break;
    cursor = batch[batch.length - 1].sku;

    const skusToDelete = [];
    for (const row of batch) {
      const record = catalogRowToEvaluateRecord(row);
      const elite = evaluateEliteCuration(record);
      if (!elite.action) continue;

      skusToDelete.push(row.sku);
      const key = elite.reasons[0] || elite.action;
      byReason[key] = (byReason[key] || 0) + 1;
    }

    for (let i = 0; i < skusToDelete.length; i += DELETE_BATCH) {
      const slice = skusToDelete.slice(i, i + DELETE_BATCH);
      await safePrisma("catalog.elitePurge.delete", () =>
        prisma.$transaction([
          prisma.catalogProductFilterTag.deleteMany({
            where: { shop, sku: { in: slice } },
          }),
          prisma.catalogProduct.deleteMany({
            where: { shop, sku: { in: slice } },
          }),
        ])
      );
      removed += slice.length;
    }
  }

  const remaining = await getCatalogProductTotal(shop);
  const message = `Curadoria de Elite concluída. Removidos ${removed.toLocaleString("pt-PT")} produtos. Restam ${remaining.toLocaleString("pt-PT")} no catálogo.`;

  const logPayload = {
    shop,
    at: new Date().toISOString(),
    before,
    removed,
    remaining,
    message,
    byReason,
  };

  await fs.mkdir(path.dirname(elitePurgeLogPath(shop)), { recursive: true });
  await fs.writeFile(elitePurgeLogPath(shop), JSON.stringify(logPayload, null, 2));

  await syncCurationQueueAfterElitePurge(shop, byReason);

  console.log(`[elite-purge] ${message}`);
  if (Object.keys(byReason).length) {
    console.log("[elite-purge] Motivos:", byReason);
  }

  return { before, removed, remaining, message, byReason };
}

/**
 * @param {string} shop
 * @param {Record<string, number>} byReason
 */
async function syncCurationQueueAfterElitePurge(shop, byReason) {
  const { loadCurationQueue, saveCurationQueue } = await import(
    "../../curation/curationQueue.server.js"
  );
  const queue = await loadCurationQueue();
  let touched = 0;

  for (const item of queue.items) {
    if (item.status === "REJECTED") continue;
    const record = {
      sku: item.sku,
      vendor: item.metadata?.vendor || "",
      netPrice: item.metadata?.netPrice ?? null,
    };
    const elite = evaluateEliteCuration(record);
    if (!elite.action) continue;

    item.status = elite.action === "AUTO_REJECT" ? "REJECTED" : "PENDING";
    item.shopifyStatus = "DRAFT";
    item.reason = elite.reasons[0] || "elite_purge";
    item.metadata = {
      ...item.metadata,
      eliteCuration: true,
      eliteAction: elite.action,
      rejectedAt: elite.action === "AUTO_REJECT" ? new Date().toISOString() : item.metadata?.rejectedAt,
      lastElitePurgeAt: new Date().toISOString(),
      shop,
    };
    touched += 1;
  }

  if (touched > 0) {
    await saveCurationQueue(queue);
    console.log(`[elite-purge] Fila de curadoria actualizada (${touched} entradas).`);
  }

  void byReason;
}

export async function readElitePurgeLog(shop) {
  try {
    const raw = await fs.readFile(elitePurgeLogPath(shop), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
