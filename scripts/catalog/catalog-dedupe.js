#!/usr/bin/env node
/**
 * Deduplica catálogo SQLite por SKU / EAN.
 * Uso: SHOP=alterpop-store.myshopify.com node scripts/catalog-dedupe.js
 */
import "dotenv/config";
import { deduplicateCatalog } from "../../lib/importer/catalog/deduplicateCatalog.server.js";
import { getCatalogProductTotal } from "../../lib/importer/catalog/catalogProductsDb.server.js";

const shop = process.env.SHOP || "alterpop-store.myshopify.com";

const before = await getCatalogProductTotal(shop);
const result = await deduplicateCatalog(shop);
const after = await getCatalogProductTotal(shop);

console.log(JSON.stringify({ before, after, ...result }, null, 2));
