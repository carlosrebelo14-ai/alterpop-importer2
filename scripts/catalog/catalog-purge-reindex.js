#!/usr/bin/env node
/**
 * Limpeza geral do catálogo Prisma + reindexação OcioStock (exclude-list activo).
 *
 * Ação DESTRUTIVA — apaga o catálogo Prisma da loja indicada. SHOP e CONFIRM
 * são obrigatórios, sem fallback, para evitar apagar a loja errada por engano.
 *
 * Uso:
 *   SHOP=alterpop-store.myshopify.com CONFIRM=APAGAR node scripts/catalog/catalog-purge-reindex.js
 */
import "dotenv/config";
import { loadShopSettings } from "../../lib/importer/settings.server.js";
import { startCatalogCleanupInBackground } from "../../lib/importer/catalog/catalogRebuild.server.js";
import { readCatalogRebuildStatus } from "../../lib/importer/catalog/catalogRebuild.server.js";

const CONFIRM_WORD = "APAGAR";

const shop = process.env.SHOP;
if (!shop) {
  console.error(
    "[catalog-purge] ABORTADO: variável SHOP não definida.\n" +
      "Este script apaga o catálogo Prisma da loja indicada — não há loja por defeito.\n" +
      "Uso: SHOP=<loja>.myshopify.com CONFIRM=APAGAR node scripts/catalog/catalog-purge-reindex.js"
  );
  process.exit(1);
}

if (process.env.CONFIRM !== CONFIRM_WORD) {
  console.error(
    `[catalog-purge] ABORTADO: falta confirmação explícita para apagar o catálogo de "${shop}".\n` +
      `Corre novamente com CONFIRM=${CONFIRM_WORD}:\n` +
      `SHOP=${shop} CONFIRM=${CONFIRM_WORD} node scripts/catalog/catalog-purge-reindex.js`
  );
  process.exit(1);
}

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
