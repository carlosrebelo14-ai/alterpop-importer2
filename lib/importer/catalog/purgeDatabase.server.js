import fs from "fs/promises";
import path from "path";
import { prisma, safePrisma } from "../../prisma/prismaSafe.server.js";
import { getDefaultConfig } from "../config.js";
import { clearExcludeListCache } from "../curation/loadExcludeList.server.js";
import { clearCurationCache } from "../curation/loadCuration.js";
import { evaluateExcludeList } from "../curation/evaluateExcludeList.server.js";
import { getCatalogProductTotal } from "./catalogProductsDb.server.js";

const SCAN_BATCH = 500;
const DELETE_BATCH = 200;

/**
 * @param {import('@prisma/client').CatalogProduct} row
 */
export function catalogRowToEvaluateRecord(row) {
  let categorySegments = [];
  try {
    categorySegments = JSON.parse(row.categorySegments || "[]");
  } catch {
    /* ignore */
  }

  return {
    sku: row.sku,
    title: row.title,
    vendor: row.vendor || "",
    category: row.categoryMain || "",
    categoryMain: row.categoryMain || "",
    categorySegments,
    netPrice: row.netPrice != null ? Number(row.netPrice) : null,
    grossPrice: row.grossPrice != null ? Number(row.grossPrice) : null,
    availableQuantity: row.stock ?? 0,
    hasStock: (row.stock ?? 0) > 0,
  };
}

function purgeLogPath(shop) {
  return path.join(
    getDefaultConfig().paths.data,
    "catalog-index",
    `${shop.replace(/\//g, "_")}-purge-log.json`
  );
}

/**
 * Remove da base de dados (Prisma) produtos que violam exclude-list.json.
 * Nota: liquidação só é avaliada na reindexação CSV (campo en_liquidacion).
 *
 * @param {string} shop
 * @returns {Promise<{ before: number, removed: number, remaining: number, message: string, byReason: Record<string, number> }>}
 */
export async function purgeDatabase(shop) {
  clearExcludeListCache();
  clearCurationCache();

  const before = await getCatalogProductTotal(shop);
  if (before === 0) {
    const message = "Limpeza concluída. Foram removidos 0 produtos. Restam 0 produtos no catálogo.";
    return { before: 0, removed: 0, remaining: 0, message, byReason: {} };
  }

  /** @type {Record<string, number>} */
  const byReason = {};
  let removed = 0;

  /** @type {string | null} */
  let cursor = null;

  for (;;) {
    const batch = await safePrisma("catalogProduct.findMany.purge", () =>
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
      const result = evaluateExcludeList(record);
      if (result.excluded) {
        skusToDelete.push(row.sku);
        const key = String(result.reason || "unknown").split(":")[0];
        byReason[key] = (byReason[key] || 0) + 1;
      }
    }

    for (let i = 0; i < skusToDelete.length; i += DELETE_BATCH) {
      const slice = skusToDelete.slice(i, i + DELETE_BATCH);
      // Fix (code review 2026-08-13): rethrow — sem isto, uma falha real na
      // transação era engolida e `removed` continuava a incrementar como se o
      // delete tivesse tido sucesso.
      await safePrisma(
        "catalog.purge.delete",
        () =>
          prisma.$transaction([
            prisma.catalogProductFilterTag.deleteMany({
              where: { shop, sku: { in: slice } },
            }),
            prisma.catalogProduct.deleteMany({
              where: { shop, sku: { in: slice } },
            }),
          ]),
        { rethrow: true }
      );
      removed += slice.length;
    }
  }

  const remaining = await getCatalogProductTotal(shop);
  const message = `Limpeza concluída. Foram removidos ${removed.toLocaleString("pt-PT")} produtos. Restam ${remaining.toLocaleString("pt-PT")} produtos no catálogo.`;

  const logPayload = {
    shop,
    at: new Date().toISOString(),
    before,
    removed,
    remaining,
    message,
    byReason,
  };

  await fs.mkdir(path.dirname(purgeLogPath(shop)), { recursive: true });
  await fs.writeFile(purgeLogPath(shop), JSON.stringify(logPayload, null, 2));

  console.log(`[purge] ${message}`);
  if (Object.keys(byReason).length) {
    console.log("[purge] Motivos:", byReason);
  }

  return { before, removed, remaining, message, byReason };
}

export async function readPurgeLog(shop) {
  try {
    const raw = await fs.readFile(purgeLogPath(shop), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
