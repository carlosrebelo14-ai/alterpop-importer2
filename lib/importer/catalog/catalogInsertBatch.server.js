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

  const skus = unique.map((p) => p.sku);
  const existing = await safePrisma("catalogProduct.findMany", () =>
    prisma.catalogProduct.findMany({
      where: { shop, sku: { in: skus } },
      select: { sku: true },
    })
  );
  const existingSkus = new Set(existing.map((r) => r.sku));
  const toInsert = unique.filter((p) => !existingSkus.has(p.sku));
  if (!toInsert.length) return;

  await safePrisma("catalogProduct.createMany", () =>
    prisma.catalogProduct.createMany({
      data: toInsert.map((p) => ({
        shop,
        sku: p.sku,
        title: p.title,
        categoryMain: p.categoryMain || null,
        categorySegments: JSON.stringify(p.categorySegments || []),
        vendor: p.vendor || null,
        vendorNorm: vendorNorm(p.vendor),
        stock: p.stock ?? 0,
        franchises: JSON.stringify(p.franchises || []),
        netPrice: p.netPrice ?? null,
        grossPrice: p.grossPrice ?? null,
        imageUrl: p.imageUrl || null,
        barcode: p.barcode?.trim() || p.sku || null,
        indexedAt: new Date(),
      })),
    })
  );

  /** @type {{ shop: string, sku: string, filterId: string }[]} */
  const tagRows = accumulatedTags || [];
  for (const p of toInsert) {
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
