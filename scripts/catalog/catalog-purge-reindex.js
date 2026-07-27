#!/usr/bin/env node
/**
 * Limpeza geral do catálogo Prisma + reindexação OcioStock (exclude-list activo).
 *
 * Uso:
 *   node scripts/catalog-purge-reindex.js
 *   SHOP=alterpop-store.myshopify.com node scripts/catalog-purge-reindex.js
 */
import "dotenv/config";
import { loadShopSettings } from "../lib/importer/settings.server.js";
import { startCatalogCleanupInBackground } from "../lib/importer/catalog/catalogRebuild.server.js";
import { readCatalogRebuildStatus } from "../lib/importer/catalog/catalogRebuild.server.js";

const shop = process.env.SHOP || "alterpop-store.myshopify.com";

const settings = await loadShopSettings(shop);
if (settings.ociostockCsvUrl) {
  process.env.OCIOSTOCK_CSV_URL = settings.ociostockCsvUrl;
}

console.log(`[catalog-purge] Loja: ${shop}`);
const result = await startCatalogCleanupInBackground(shop, settings);

try {
  await result;
} catch (err) {
  console.error("[catalog-purge] Falhou:", err?.message || err);
  process.exit(1);
}

const status = await readCatalogRebuildStatus(shop);
console.log(status?.purge?.message || status?.message || "Concluído.");
if (status?.totalRows != null) {
  console.log(`[catalog-purge] Total após reindexação: ${status.totalRows}`);
}
