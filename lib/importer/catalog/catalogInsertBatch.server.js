import { prisma, safePrisma } from "../../prisma/prismaSafe.server.js";
import {
  computeFilterTagIdsForProduct,
} from "./sitemapFilters.server.js";

const BATCH = 250;

/** @param {string} value */
function vendorNorm(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * @param {string} shop
 * @param {import('./catalogProducts.server.js').ReturnType<typeof import('./catalogProducts.server.js').toLiteProduct>[]} chunk
 * @param {{ accumulatedTags?: { shop: string, sku: string, filterId: string }[] }} [options]
 */
export async function insertCatalogProductBatch(shop, chunk, options = {}) {
  if (!chunk.length) return;
  const { accumulatedTags = null } = options;

  /** @type {Map<string, typeof chunk[0]>} */
  const bySku = new Map();
  for (const p of chunk) {
    if (p?.sku) bySku.set(p.sku, p);
  }
  const unique = [...bySku.values()];
  if (!unique.length) return;

  // 14 colunas por produto * 50 produtos = 700 parâmetros (< limite de 999 do SQLite)
  const CHUNK = 50;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK);
    const valueClauses = [];
    const params = [];

    for (const p of slice) {
      valueClauses.push("(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))");
      params.push(
        shop,
        p.sku,
        p.title,
        p.categoryMain || null,
        JSON.stringify(p.categorySegments || []),
        p.vendor || null,
        vendorNorm(p.vendor),
        p.stock ?? 0,
        JSON.stringify(p.franchises || []),
        p.netPrice ?? null,
        p.grossPrice ?? null,
        p.imageUrl || null,
        p.barcode?.trim() || p.sku || null
      );
    }

    const sql = `
      INSERT INTO CatalogProduct (shop, sku, title, categoryMain, categorySegments, vendor, vendorNorm, stock, franchises, netPrice, grossPrice, imageUrl, barcode, indexedAt)
      VALUES ${valueClauses.join(", ")}
      ON CONFLICT(shop, sku) DO UPDATE SET
        title = excluded.title,
        categoryMain = excluded.categoryMain,
        categorySegments = excluded.categorySegments,
        vendor = excluded.vendor,
        vendorNorm = excluded.vendorNorm,
        stock = excluded.stock,
        franchises = excluded.franchises,
        netPrice = excluded.netPrice,
        grossPrice = excluded.grossPrice,
        imageUrl = excluded.imageUrl,
        barcode = excluded.barcode,
        indexedAt = excluded.indexedAt;
    `;

    await safePrisma("catalogProduct.upsertBatch", () =>
      prisma.$executeRawUnsafe(sql, ...params)
    );
  }

  /** @type {{ shop: string, sku: string, filterId: string }[]} */
  const tagRows = accumulatedTags || [];
  for (const p of unique) {
    for (const filterId of computeFilterTagIdsForProduct(p)) {
      tagRows.push({ shop, sku: p.sku, filterId });
    }
  }

  if (!accumulatedTags && tagRows.length) {
    await bulkInsertCatalogFilterTags(tagRows);
  }
}

/**
 * Insere todas as tags de sitemap em blocos de 2000 no final da indexação.
 * @param {{ shop: string, sku: string, filterId: string }[]} tags
 */
export async function bulkInsertCatalogFilterTags(tags = []) {
  if (!tags.length) return;
  const CHUNK = 250;
  for (let i = 0; i < tags.length; i += CHUNK) {
    const slice = tags.slice(i, i + CHUNK);
    await safePrisma("catalogProductFilterTag.createMany", () =>
      prisma.catalogProductFilterTag.createMany({ data: slice }).catch((err) => {
        if (String(err?.message || "").includes("Unique constraint")) return;
        throw err;
      })
    );
  }
}
