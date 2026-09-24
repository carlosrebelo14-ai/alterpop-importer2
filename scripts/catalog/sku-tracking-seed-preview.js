#!/usr/bin/env node
/**
 * Pré-visualização, só leitura, do que a próxima corrida de runSkuLifecycleCycle
 * vai fazer depois do fix do bug skipDuplicates (24/09). Não escreve nada — conta
 * CatalogProduct e CatalogSkuTracking e diz se o próximo ciclo vai entrar em modo
 * semente (tracking vazio + catálogo real) e quantas linhas ficariam gravadas como
 * linha de base, sem nenhuma reportada como novidade.
 *
 * Corre na Fly (é lá que está a base de dados real):
 *   flyctl ssh console -a alterpop-importer-app \
 *     -C "node scripts/catalog/sku-tracking-seed-preview.js"
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";

const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";

async function main() {
  console.log(`=== sku-tracking-seed-preview (${SHOP}) · só leitura ===`);

  const catalogCount = await prisma.catalogProduct.count({ where: { shop: SHOP } });
  const trackingCount = await prisma.catalogSkuTracking.count({ where: { shop: SHOP } });
  const trackingRows = await prisma.catalogSkuTracking.findMany({
    where: { shop: SHOP },
    select: { sku: true },
  });
  const trackedSkus = new Set(trackingRows.map((r) => r.sku));

  const currentRows = await prisma.catalogProduct.findMany({
    where: { shop: SHOP },
    select: { sku: true },
  });
  const newCount = currentRows.filter((r) => !trackedSkus.has(r.sku)).length;

  console.log(`CatalogProduct (catálogo atual): ${catalogCount}`);
  console.log(`CatalogSkuTracking (linha de base atual): ${trackingCount}`);

  const isSeedRun = trackingCount === 0 && catalogCount > 0;
  console.log(`\nPróximo ciclo entra em modo semente: ${isSeedRun ? "SIM" : "não"}`);

  if (isSeedRun) {
    console.log(`  → gravaria ${newCount} SKUs como linha de base em CatalogSkuTracking`);
    console.log(`  → newSkuCount reportado no relatório do ciclo: 0 (não é novidade real)`);
    console.log(`  → destaque VIP: nenhum disparado`);
    console.log(`  → lotes de 500, dentro de transação, sem createMany/skipDuplicates`);
  } else if (trackingCount > 0) {
    console.log(`  → tracking já tem linhas; o próximo ciclo reportaria ${newCount} novidade(s) reais.`);
  } else {
    console.log(`  → catálogo vazio; nada a semear.`);
  }
}

main()
  .catch((err) => {
    console.error(err?.stack || err?.message || err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
