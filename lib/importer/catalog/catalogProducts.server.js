import fs from "fs/promises";
import path from "path";
import { getDefaultConfig } from "../config.js";
import {
  getCatalogProductTotal,
  syncCatalogProductsFromStream,
} from "./catalogProductsDb.server.js";

const TTL_MS = 24 * 60 * 60 * 1000;

function productsPath(shop) {
  return path.join(
    getDefaultConfig().paths.data,
    "catalog-index",
    `${shop.replace(/\//g, "_")}-products-lite.json`
  );
}

/**
 * @param {import('../types.js').ProductRecord} r
 */
export function toLiteProduct(r) {
  const categoryMain = (r.categoryMain || r.category || "").trim();
  return {
    sku: r.sku || "",
    title: r.title || r.sku || "",
    categoryMain,
    categorySegments: (r.categorySegments || []).filter(Boolean),
    vendor: r.vendor || "",
    stock: r.availableQuantity ?? 0,
    franchises: (r.franchises || []).slice(0, 5),
    netPrice: r.netPrice ?? null,
    grossPrice: r.grossPrice ?? null,
    imageUrl: r.imageUrl?.trim() || null,
    barcode: r.barcode?.trim() || r.sku || null,
  };
}

/**
 * @param {import('../types.js').ProductRecord[]} records
 */
export function buildProductsLite(records) {
  return records.map(toLiteProduct).filter((p) => p.sku);
}

export async function loadCatalogProductsLite(shop, settings = {}, { refresh = false } = {}) {
  const file = productsPath(shop);

  if (!refresh) {
    try {
      const raw = await fs.readFile(file, "utf8");
      const cached = JSON.parse(raw);
      if (Date.now() - new Date(cached.updatedAt).getTime() < TTL_MS) {
        return cached;
      }
    } catch {
      /* rebuild */
    }
  }

  return refreshCatalogProductsLite(shop, settings);
}

export async function refreshCatalogProductsLite(shop, settings = {}) {
  await fs.mkdir(path.dirname(productsPath(shop)), { recursive: true });

  if (settings.ociostockCsvUrl) {
    process.env.OCIOSTOCK_CSV_URL = settings.ociostockCsvUrl;
  }

  const totalRows = await syncCatalogProductsFromStream(shop);

  const payload = {
    updatedAt: new Date().toISOString(),
    totalRows,
    products: [],
    dbSynced: true,
  };

  await fs.writeFile(productsPath(shop), JSON.stringify(payload));
  return payload;
}

export { getCatalogProductTotal };
