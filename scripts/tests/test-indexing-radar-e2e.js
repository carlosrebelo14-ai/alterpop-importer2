#!/usr/bin/env node
/**
 * Teste E2E local: worker fork + eventos (mesmo canal que o SSE).
 * Uso: node scripts/test-indexing-radar-e2e.js
 */
import "dotenv/config";
import { loadShopSettings } from "../lib/importer/settings.server.js";
import {
  startCatalogRebuildInBackground,
  subscribeIndexingEvents,
  isCatalogIndexingRunning,
} from "../lib/importer/catalog/catalogRebuild.server.js";

const shop = process.env.SHOP || "alterpop-store.myshopify.com";
const MIN_PRODUCTS = Number(process.env.MIN_PRODUCTS || 3);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 120_000);

const settings = await loadShopSettings(shop);
if (settings.ociostockCsvUrl) {
  process.env.OCIOSTOCK_CSV_URL = settings.ociostockCsvUrl;
}

let products = 0;
let indexed = 0;
let scanned = 0;
let phase = "idle";
let done = false;
let failed = null;

const unsubscribe = subscribeIndexingEvents(shop, (ev) => {
  if (ev.type === "progress") {
    phase = ev.phase || phase;
    if (ev.indexed != null) indexed = ev.indexed;
    if (ev.scanned != null) scanned = ev.scanned;
    process.stdout.write(
      `\r[radar-e2e] phase=${phase} indexed=${indexed} scanned=${scanned}   `
    );
  }
  if (ev.type === "product" && ev.product) {
    products += 1;
    if (products <= 5) {
      console.log(
        `\n[radar-e2e] produto #${products}: ${ev.product.sku} — ${ev.product.title?.slice(0, 60)}`
      );
    }
  }
  if (ev.type === "done") {
    done = true;
    indexed = ev.indexed ?? indexed;
    console.log(`\n[radar-e2e] done indexed=${ev.indexed} scanned=${ev.scanned}`);
  }
  if (ev.type === "error") {
    failed = ev.message;
  }
});

console.log(`[radar-e2e] Loja: ${shop}`);
console.log(`[radar-e2e] A iniciar worker (reindexação, sem purge)…`);

if (isCatalogIndexingRunning(shop)) {
  console.warn("[radar-e2e] Já existe indexação em curso — a escutar apenas.");
} else {
  startCatalogRebuildInBackground(shop, settings);
}

const started = Date.now();

await new Promise((resolve) => {
  const tick = setInterval(() => {
    if (failed) {
      clearInterval(tick);
      resolve();
      return;
    }
    if (products >= MIN_PRODUCTS) {
      clearInterval(tick);
      resolve();
      return;
    }
    if (done) {
      clearInterval(tick);
      resolve();
      return;
    }
    if (Date.now() - started > TIMEOUT_MS) {
      clearInterval(tick);
      resolve();
      return;
    }
  }, 500);
});

unsubscribe();

const ok = !failed && products >= MIN_PRODUCTS;
console.log("\n[radar-e2e] Resumo:", {
  ok,
  productsSeen: products,
  indexed,
  scanned,
  phase,
  elapsedSec: Math.round((Date.now() - started) / 1000),
  stillRunning: isCatalogIndexingRunning(shop),
});

if (failed) {
  console.error("[radar-e2e] ERRO:", failed);
  process.exit(1);
}
if (!ok) {
  console.error(`[radar-e2e] FALHOU: esperados >= ${MIN_PRODUCTS} eventos product, recebidos ${products}`);
  process.exit(1);
}

console.log("[radar-e2e] OK — pipeline worker → postMessage → SSE subscribers funcional.");
process.exit(0);
