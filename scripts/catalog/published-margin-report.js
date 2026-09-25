#!/usr/bin/env node
/**
 * Relatório só-leitura, sobre todos os SKUs PUBLISHED: custo (netPrice), MSRP do
 * fornecedor (grossPrice, a mesma coluna que alimenta a cor da tabela de curadoria —
 * ver marginWarnThresholdPct), preço live na Shopify, margem live sem IVA, margem ao
 * MSRP sem IVA, e live-vs-MSRP.
 *
 * Metodologia (igual à do Carlos, 25/09):
 *   - shop.taxesIncluded = true nesta loja — preço live e MSRP são ambos apresentados
 *     COM IVA. "sem IVA" divide os dois por (1 + IVA_RATE) antes de calcular margem.
 *   - margem = (preçoSemIVA - custo) / preçoSemIVA × 100 (margem sobre venda, não
 *     sobre custo — fórmula do painel, não a do publisher).
 *   - live-vs-MSRP = (live - MSRP) / MSRP × 100, direto (o IVA cancela no rácio).
 *
 * Nada escrito. Não toca em preço nem publica nada.
 *
 * Corre na Fly:
 *   node scripts/catalog/published-margin-report.js
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { listCurationQueueItems } from "../../lib/curation/curationQueue.server.js";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";

const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
const IVA_RATE = 0.23;
const CHUNK = 40; // SKUs por query GraphQL — mantém a string de busca dentro de limites seguros

const VARIANTS_BY_SKU_QUERY = `
  query VariantsBySku($query: String!) {
    productVariants(first: 250, query: $query) {
      nodes {
        sku
        price
        product { title }
      }
    }
  }
`;

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function semIva(v) {
  return v == null ? null : v / (1 + IVA_RATE);
}

function margemPct(precoSemIva, custo) {
  if (precoSemIva == null || !(precoSemIva > 0) || custo == null) return null;
  return ((precoSemIva - custo) / precoSemIva) * 100;
}

async function fetchLivePrices(client, skus) {
  const bySku = new Map();
  for (const chunk of chunkArray(skus, CHUNK)) {
    const query = chunk.map((s) => `sku:"${String(s).replace(/"/g, '\\"')}"`).join(" OR ");
    try {
      const data = await client.graphql(VARIANTS_BY_SKU_QUERY, { query });
      for (const v of data.productVariants?.nodes || []) {
        bySku.set(v.sku, { price: Number(v.price), title: v.product?.title || null });
      }
    } catch (err) {
      console.error(`[published-margin-report] chunk falhou (${chunk.length} SKUs): ${err?.message || err}`);
    }
  }
  return bySku;
}

function band(marginAtMsrp) {
  if (marginAtMsrp == null) return "sem dados";
  if (marginAtMsrp < 0) return "< 0%";
  if (marginAtMsrp < 15) return "0–15%";
  if (marginAtMsrp < 30) return "15–30%";
  return "> 30%";
}

async function main() {
  console.log(`=== published-margin-report (${SHOP}) · só leitura ===\n`);

  const published = await listCurationQueueItems("PUBLISHED");
  const skus = published.map((i) => i.sku).filter(Boolean);
  console.log(`PUBLISHED na fila: ${skus.length}`);

  const catalogRows = await prisma.catalogProduct.findMany({
    where: { shop: SHOP, sku: { in: skus } },
    select: { sku: true, title: true, vendor: true, netPrice: true, grossPrice: true },
  });
  const catalogBySku = new Map(catalogRows.map((r) => [r.sku, r]));
  console.log(`Encontrados em CatalogProduct: ${catalogRows.length} (${skus.length - catalogRows.length} fora do catálogo indexado — provavelmente saíram do feed)`);

  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);
  const liveBySku = await fetchLivePrices(client, skus);
  console.log(`Preços live encontrados: ${liveBySku.size}\n`);

  const rows = [];
  for (const sku of skus) {
    const cat = catalogBySku.get(sku);
    const live = liveBySku.get(sku);
    if (!cat || !live) continue; // sem dados suficientes — excluído do relatório, não do total acima

    const custo = cat.netPrice;
    const msrp = cat.grossPrice;
    const livePrice = live.price;

    const margemLive = margemPct(semIva(livePrice), custo);
    const margemMsrp = margemPct(semIva(msrp), custo);
    const liveVsMsrp = msrp && msrp > 0 ? ((livePrice - msrp) / msrp) * 100 : null;

    rows.push({
      sku,
      title: cat.title || live.title,
      vendor: cat.vendor || "(sem vendor)",
      custo,
      msrp,
      livePrice,
      margemLive,
      margemMsrp,
      liveVsMsrp,
    });
  }

  console.log(`Linhas com dados completos (custo + MSRP + preço live): ${rows.length}\n`);

  console.log(
    "SKU".padEnd(16) +
      "Custo".padStart(9) +
      "MSRP".padStart(9) +
      "Live".padStart(9) +
      "Marg.Live%".padStart(12) +
      "Marg.MSRP%".padStart(12) +
      "Live/MSRP%".padStart(12) +
      "  Título"
  );
  for (const r of rows.sort((a, b) => (a.margemMsrp ?? 999) - (b.margemMsrp ?? 999))) {
    console.log(
      r.sku.padEnd(16) +
        r.custo.toFixed(2).padStart(9) +
        (r.msrp?.toFixed(2) ?? "—").padStart(9) +
        r.livePrice.toFixed(2).padStart(9) +
        (r.margemLive?.toFixed(1) ?? "—").padStart(12) +
        (r.margemMsrp?.toFixed(1) ?? "—").padStart(12) +
        (r.liveVsMsrp?.toFixed(1) ?? "—").padStart(12) +
        "  " + (r.title || "").slice(0, 50)
    );
  }

  console.log(`\n--- Resumo por fabricante (vendor) ---`);
  const byVendor = new Map();
  for (const r of rows) {
    if (!byVendor.has(r.vendor)) byVendor.set(r.vendor, []);
    byVendor.get(r.vendor).push(r);
  }
  for (const [vendor, list] of [...byVendor.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const avgMargemMsrp = list.reduce((s, r) => s + (r.margemMsrp ?? 0), 0) / list.length;
    console.log(`  ${vendor.padEnd(20)} ${String(list.length).padStart(3)} produtos · margem média ao MSRP: ${avgMargemMsrp.toFixed(1)}%`);
  }

  console.log(`\n--- Resumo por faixa de margem ao MSRP (sem IVA) ---`);
  const byBand = new Map();
  for (const r of rows) {
    const b = band(r.margemMsrp);
    byBand.set(b, (byBand.get(b) || 0) + 1);
  }
  for (const b of ["< 0%", "0–15%", "15–30%", "> 30%", "sem dados"]) {
    if (byBand.has(b)) console.log(`  ${b.padEnd(12)} ${byBand.get(b)} produtos`);
  }
}

main()
  .catch((err) => {
    console.error(err?.stack || err?.message || err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
