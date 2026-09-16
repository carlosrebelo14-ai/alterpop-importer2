import fs from "fs/promises";
import path from "path";
import { getDefaultConfig } from "../config.js";
import {
  getCatalogProductTotal,
  syncCatalogProductsFromStream,
} from "./catalogProductsDb.server.js";
import { resolveFranchise } from "./franchiseResolver.server.js";
import { cleanProductTitle } from "./titleCleaner.server.js";
import { extractProductFormat } from "./formatExtractor.server.js";
import { extractManufacturerLine } from "./manufacturerLineExtractor.server.js";

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
  const allImgs = [r.imageUrl, r.imageUrlLarge, ...(r.extraImages || [])]
    .filter(Boolean)
    .map((u) => String(u).trim())
    .filter((u) => /^https?:\/\/[^\s]+/i.test(u));
  const uniqueImgs = Array.from(new Set(allImgs));

  const franchiseRefs = (r.franchiseRefs || []).filter(Boolean);
  const resolved = resolveFranchise({
    franchiseRefs,
    title: r.title || "",
    titleSource: r.titleSource ?? null,
  });

  const title = r.title || r.sku || "";
  // Tarefa 34 — formato de produto (Figure, Keychain, Backpack, …). Alimenta
  // alterpop.format no publish (Tarefa 35). Extraído do título BRUTO e antes da limpeza:
  // o sinal costuma estar no próprio prefixo que a limpeza vai remover.
  const resolvedFormat = extractProductFormat({ title });
  // B6 — linha do fabricante (Ichibansho, Grandista, …), extraída do título bruto +
  // vendor. Vocabulário fechado por fabricante; fora do mapa fica null.
  const resolvedManufacturerLine = extractManufacturerLine({ vendor: r.vendor || "", title });
  // Tarefa 10 — corre depois do resolver, precisa de resolved.franchise para colapsar
  // franquia repetida no título. originalTitle preserva o bruto; cleanTitle é o
  // candidato à publicação (titleOverride ?? cleanTitle no shopifyMapper).
  // `resolvedFormat` é a guarda do averbamento à Decisão 17: sem ele o prefixo de
  // formato fica no título, porque não tem para onde ir.
  const cleanTitle = cleanProductTitle({ title, resolvedFranchise: resolved.franchise, resolvedFormat });

  return {
    sku: r.sku || "",
    title,
    originalTitle: title,
    cleanTitle,
    resolvedFormat,
    resolvedManufacturerLine,
    categoryMain,
    categorySegments: (r.categorySegments || []).filter(Boolean),
    vendor: r.vendor || "",
    stock: r.availableQuantity ?? 0,
    franchises: (r.franchises || []).slice(0, 5),
    franchiseRefs,
    resolvedFranchise: resolved.franchise,
    resolvedFranchiseLayer: resolved.franchise ? resolved.layer : null,
    resolvedLine: resolved.line ?? null,
    netPrice: r.netPrice ?? null,
    grossPrice: r.grossPrice ?? null,
    imageUrl: uniqueImgs.length > 0 ? uniqueImgs.join(",") : null,
    barcode: r.barcode?.trim() || r.sku || null,
    weightKg: r.weightKg ?? null,
    titleSource: r.titleSource ?? null,
    dimensions: r.dimensions ?? null,
    hsCode: r.hsCode ?? null,
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
