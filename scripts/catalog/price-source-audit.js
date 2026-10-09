#!/usr/bin/env node
/**
 * A1 do briefing de integridade (09/10/2026) — SÓ LEITURA. Nada é escrito, nada vai à Shopify.
 *
 * Para um SKU, mostra de onde vem a margem que cada parte da app lê hoje:
 *   - margem global (settings.priceMarginPct) e a data do ficheiro de definições;
 *   - override do produto na fila (metadata.overrides.marginPct), estado, publishedAt;
 *   - o preço que a regra dá com a margem que o painel lê agora, e a 10 % e 20 %.
 * Serve para dizer qual margem explica o preço live (ex.: Gandalf 889698135504, 14,90).
 *
 * Correr na Fly:
 *   node scripts/catalog/price-source-audit.js 889698135504
 * Para ver quem escreveu o preço, ver também:
 *   flyctl logs -a alterpop-importer-app --no-tail | grep 889698135504
 */
import fs from "node:fs";
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { getCurationQueueEntry } from "../../lib/curation/curationQueue.server.js";
import { loadShopSettings } from "../../lib/importer/settings.server.js";
import { getDefaultConfig } from "../../lib/importer/config.js";
import path from "node:path";
import {
  resolveMarginPct,
  productMarginPct,
  tryPriceProduct,
} from "../../lib/importer/pricing/pricing.server.js";

const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
const sku = process.argv[2];
if (!sku) {
  console.error("Uso: node scripts/catalog/price-source-audit.js <sku>");
  process.exit(1);
}

const show = (label, v) => console.log(`${label.padEnd(34)} ${v}`);

async function main() {
  console.log(`=== price-source-audit ${sku} (${SHOP}) · SÓ LEITURA ===\n`);

  const settingsFile = path.join(getDefaultConfig().paths.data, "settings", `${SHOP.replace(/\//g, "_")}.json`);
  let mtime = "ficheiro não existe";
  try {
    mtime = fs.statSync(settingsFile).mtime.toISOString();
  } catch {
    /* ENOENT: valores por defeito */
  }
  const settings = await loadShopSettings(SHOP);
  let globalPct;
  try {
    globalPct = resolveMarginPct(settings);
  } catch (err) {
    globalPct = `ERRO: ${err.message}`;
  }
  show("priceMarginPct (gravada)", JSON.stringify(settings.priceMarginPct));
  show("definições modificadas em", mtime);
  show("margem global resolvida", globalPct);

  const entry = await getCurationQueueEntry(sku);
  console.log("");
  if (!entry) {
    show("fila", "SKU não está na fila");
  } else {
    show("estado na fila", entry.status);
    show("override marginPct (fila)", JSON.stringify(entry.metadata?.overrides?.marginPct ?? null));
    show("override price (fila)", JSON.stringify(entry.metadata?.overrides?.price ?? null));
    show("publishedAt", entry.metadata?.publishedAt ?? "—");
    show("shopifyProductId", entry.metadata?.shopifyProductId ?? "—");
    show("syncError", entry.metadata?.syncError ?? "—");
  }

  const row = await prisma.catalogProduct.findFirst({
    where: { shop: SHOP, sku },
    select: { distributorPrice: true, grossPrice: true, title: true },
  });
  console.log("");
  if (!row) {
    show("catálogo", "SKU não está no catálogo indexado");
    return;
  }
  show("título", row.title);
  show("precio_distribuidores (s/ IVA)", row.distributorPrice);
  show("PVPR (precio_bruto)", row.grossPrice);

  let panelPct = globalPct;
  try {
    panelPct = productMarginPct(globalPct, entry);
  } catch (err) {
    panelPct = `ERRO: ${err.message}`;
  }
  console.log("\nPreço que a regra dá:");
  const rows = [["margem que o painel lê agora", panelPct], ["10 %", 10], ["20 %", 20]];
  for (const [label, pct] of rows) {
    if (typeof pct !== "number") {
      show(label, String(pct));
      continue;
    }
    const r = tryPriceProduct(row.distributorPrice, row.grossPrice, pct);
    show(`${label} (${pct} %)`, `${r.finalPrice ?? r.priceError}  [${r.priceStatus ?? "—"}]`);
  }
}

main()
  .catch((err) => {
    console.error("Erro:", err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect?.());
