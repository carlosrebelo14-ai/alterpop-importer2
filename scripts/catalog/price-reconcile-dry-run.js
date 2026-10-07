#!/usr/bin/env node
/**
 * Passo 7 do briefing "Preço com margem e teto de mercado" (07/10/2026) — dry-run da
 * passagem dos produtos PUBLISHED à regra nova (pricing.server.js). SÓ LEITURA: não
 * escreve nada na Shopify nem na base de dados. PARAR depois disto — a aplicação
 * espera o OK do Carlos sobre a lista.
 *
 * Custo e PVPR vêm do FEED FRESCO (precio_distribuidores, precio_bruto), não do
 * catálogo: corre antes do deploy que acrescenta CatalogProduct.distributorPrice. O
 * mesmo passeio pelo feed dá a contagem de nulos pedida no passo 1.
 *
 * Só entram em "muda" preços que a app escreveu. Um preço live conta como escrito pela
 * app quando bate (ao cêntimo) com uma das fórmulas antigas:
 *   - publisher:  round2(precio_neto × 1,4), com precio_neto = costAtPublish (custo no
 *                 momento da publicação) ou, sem ele, o netPrice atual do catálogo;
 *   - importer:   precio_bruto (a página Import escrevia grossPrice sem margem).
 * Tudo o resto fica de fora e é listado com o motivo:
 *   - manual:      preço live não bate com nenhuma fórmula — editado à mão, nunca reescrito;
 *   - override:    preço fixado na curadoria (CSV re-import) — é decisão do Carlos;
 *   - sync_locked: ociostock.sync_locked=true;
 *   - sem dados:   fora do feed, sem variante live, ou sem precio_distribuidores.
 *
 * Saída: resumo no terminal (por categoria e por estado de preço) +
 * results/price-reconcile-dry-run-<data>.csv com todas as linhas.
 *
 * Margem: a gravada nas definições da loja, ou PRICE_MARGIN_PCT=NN para simular outra.
 *
 * Corre na Fly:
 *   node scripts/catalog/price-reconcile-dry-run.js
 *   PRICE_MARGIN_PCT=35 node scripts/catalog/price-reconcile-dry-run.js
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { listCurationQueueItems } from "../../lib/curation/curationQueue.server.js";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { loadShopSettings } from "../../lib/importer/settings.server.js";
import { streamOcioStockRows } from "../../lib/importer/connectors/ociostock/streamCsv.js";
import {
  resolveMarginPct,
  assertMarginPct,
  tryPriceProduct,
  PRICE_STATUS,
} from "../../lib/importer/pricing/pricing.server.js";

const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";
const CHUNK = 40; // SKUs por query GraphQL — o mesmo do published-margin-report.js
const OLD_PUBLISHER_MARGIN = 1.4;

const VARIANTS_BY_SKU_QUERY = `
  query VariantsBySku($query: String!) {
    productVariants(first: 250, query: $query) {
      nodes {
        sku
        price
        product {
          title
          syncLocked: metafield(namespace: "ociostock", key: "sync_locked") { value }
        }
      }
    }
  }
`;

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const cents = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100));

function parseFeedPrice(value) {
  const n = parseFloat(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Passeio único pelo feed: preços dos SKUs publicados + contagem de nulos do feed todo.
 * @param {Set<string>} wanted
 */
async function readFeedPrices(wanted) {
  const bySku = new Map();
  const counts = { rows: 0, distNull: 0, pvprNull: 0 };
  await streamOcioStockRows({
    onRow: async (row) => {
      counts.rows += 1;
      const dist = parseFeedPrice(row.precio_distribuidores);
      const pvpr = parseFeedPrice(row.precio_bruto);
      if (dist == null) counts.distNull += 1;
      if (pvpr == null) counts.pvprNull += 1;
      const sku = String(row.referencia || "").trim();
      if (wanted.has(sku)) bySku.set(sku, { distributorPrice: dist, grossPrice: pvpr });
    },
  });
  return { bySku, counts };
}

/** Chunk que falha aborta o dry-run — uma lista incompleta não serve para dar o OK. */
async function fetchLiveVariants(client, skus) {
  const bySku = new Map();
  for (const chunk of chunkArray(skus, CHUNK)) {
    const query = chunk.map((s) => `sku:"${String(s).replace(/"/g, '\\"')}"`).join(" OR ");
    const data = await client.graphql(VARIANTS_BY_SKU_QUERY, { query });
    for (const v of data.productVariants?.nodes || []) {
      if (bySku.has(v.sku)) {
        bySku.set(v.sku, { ...bySku.get(v.sku), duplicate: true });
        continue;
      }
      bySku.set(v.sku, {
        price: Number(v.price),
        title: v.product?.title || null,
        syncLocked: v.product?.syncLocked?.value === "true",
      });
    }
  }
  return bySku;
}

/**
 * @returns {{ category: string, reason: string, price: ReturnType<typeof tryPriceProduct>|null }}
 */
function classify({ item, cat, feed, live, marginPct }) {
  if (!feed) return { category: "sem dados", reason: "SKU fora do feed atual", price: null };
  if (!live) return { category: "sem dados", reason: "sem variante live na Shopify", price: null };
  if (live.duplicate) return { category: "sem dados", reason: "SKU em mais de uma variante live", price: null };

  const price = tryPriceProduct(feed.distributorPrice, feed.grossPrice, marginPct);
  if (live.syncLocked) return { category: "sync_locked", reason: "ociostock.sync_locked=true", price };

  const override = item.metadata?.overrides?.price;
  if (override != null && Number(override) > 0) {
    return { category: "override", reason: `preço fixado na curadoria (${Number(override).toFixed(2)})`, price };
  }
  if (price.priceError) return { category: "sem dados", reason: price.priceError, price };

  const liveC = cents(live.price);
  const costAtPublish = item.metadata?.costAtPublish;
  const candidates = [
    costAtPublish != null ? ["publisher ×1,4 (custo na publicação)", cents(costAtPublish * OLD_PUBLISHER_MARGIN)] : null,
    cat?.netPrice != null ? ["publisher ×1,4 (custo atual)", cents(cat.netPrice * OLD_PUBLISHER_MARGIN)] : null,
    cat?.grossPrice != null ? ["importer (precio_bruto)", cents(cat.grossPrice)] : null,
  ].filter(Boolean);
  const match = candidates.find(([, c]) => c === liveC);
  if (!match) return { category: "manual", reason: "preço live não bate com nenhuma fórmula da app", price };

  if (cents(price.finalPrice) === liveC) return { category: "igual", reason: match[0], price };
  return { category: "muda", reason: match[0], price };
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const fmt = (v) => (v == null ? "—" : v.toFixed(2));

async function main() {
  console.log(`=== price-reconcile-dry-run (${SHOP}) · SÓ LEITURA ===\n`);

  const settings = await loadShopSettings(SHOP);
  const marginPct = process.env.PRICE_MARGIN_PCT
    ? assertMarginPct(process.env.PRICE_MARGIN_PCT)
    : resolveMarginPct(settings);
  console.log(`Margem global: ${marginPct}%${process.env.PRICE_MARGIN_PCT ? " (simulada via PRICE_MARGIN_PCT)" : ""}`);

  // O feed lê-se pelo mesmo caminho do indexador: OCIOSTOCK_CSV_URL, ou o URL das definições.
  if (settings.ociostockCsvUrl && !process.env.OCIOSTOCK_CSV_PATH) {
    process.env.OCIOSTOCK_CSV_URL = settings.ociostockCsvUrl;
  }

  const published = await listCurationQueueItems("PUBLISHED");
  const itemsBySku = new Map(published.filter((i) => i.sku).map((i) => [i.sku, i]));
  const skus = [...itemsBySku.keys()];
  console.log(`PUBLISHED na fila: ${skus.length}`);

  console.log("A ler o feed fresco…");
  const { bySku: feedBySku, counts } = await readFeedPrices(new Set(skus));
  console.log(
    `Feed: ${counts.rows} linhas · sem precio_distribuidores: ${counts.distNull} · sem precio_bruto: ${counts.pvprNull}`
  );
  const pubDistNull = skus.filter((s) => feedBySku.has(s) && feedBySku.get(s).distributorPrice == null).length;
  console.log(`Publicados no feed: ${feedBySku.size} de ${skus.length} · desses sem precio_distribuidores: ${pubDistNull}`);

  const catalogRows = await prisma.catalogProduct.findMany({
    where: { shop: SHOP, sku: { in: skus } },
    select: { sku: true, title: true, netPrice: true, grossPrice: true },
  });
  const catalogBySku = new Map(catalogRows.map((r) => [r.sku, r]));

  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);
  const liveBySku = await fetchLiveVariants(client, skus);
  console.log(`Em CatalogProduct: ${catalogRows.length} · variantes live: ${liveBySku.size}\n`);

  const rows = skus.map((sku) => {
    const item = itemsBySku.get(sku);
    const cat = catalogBySku.get(sku);
    const feed = feedBySku.get(sku);
    const live = liveBySku.get(sku);
    const { category, reason, price } = classify({ item, cat, feed, live, marginPct });
    const before = live?.price ?? null;
    const applies = category === "muda" || category === "igual";
    return {
      sku,
      title: cat?.title || live?.title || "",
      cost: price?.cost ?? null,
      pvpr: price?.pvpr ?? feed?.grossPrice ?? null,
      before,
      after: applies ? price.finalPrice : null,
      // Fora de "muda"/"igual": o que a regra daria, só para referência — nunca aplicado.
      ruleWouldBe: price?.finalPrice ?? null,
      profit: price?.profit ?? null,
      priceStatus: price?.priceStatus ?? null,
      delta: category === "muda" && before != null ? (cents(price.finalPrice) - cents(before)) / 100 : null,
      category,
      reason,
    };
  });

  const order = ["muda", "igual", "manual", "override", "sync_locked", "sem dados"];
  console.log("--- Por categoria ---");
  for (const c of order) console.log(`  ${c.padEnd(12)} ${rows.filter((r) => r.category === c).length}`);

  console.log("\n--- Por estado de preço (todos os que têm preço calculado) ---");
  for (const st of Object.values(PRICE_STATUS)) {
    console.log(`  ${st.padEnd(12)} ${rows.filter((r) => r.priceStatus === st).length}`);
  }

  const changing = rows.filter((r) => r.category === "muda");
  if (changing.length) {
    const up = changing.filter((r) => r.delta > 0);
    const down = changing.filter((r) => r.delta < 0);
    const sum = changing.reduce((s, r) => s + r.delta, 0);
    const profit = changing.reduce((s, r) => s + r.profit, 0);
    console.log(`\n  sobem: ${up.length} · descem: ${down.length} · variação total: ${sum.toFixed(2)} € · lucro unitário somado: ${profit.toFixed(2)} €`);

    console.log("\n--- Muda (ordenado pela maior variação absoluta) ---");
    console.log(
      "SKU".padEnd(16) +
        "Custo".padStart(8) +
        "PVPR".padStart(8) +
        "Antes".padStart(8) +
        "Depois".padStart(8) +
        "Δ".padStart(8) +
        "Lucro".padStart(8) +
        "  Estado".padEnd(13) +
        "  Título"
    );
    for (const r of [...changing].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))) {
      console.log(
        r.sku.padEnd(16) +
          fmt(r.cost).padStart(8) +
          fmt(r.pvpr).padStart(8) +
          fmt(r.before).padStart(8) +
          fmt(r.after).padStart(8) +
          fmt(r.delta).padStart(8) +
          fmt(r.profit).padStart(8) +
          `  ${r.priceStatus}`.padEnd(13) +
          "  " + r.title.slice(0, 45)
      );
    }
  }

  const others = rows.filter((r) => r.category !== "muda" && r.category !== "igual");
  if (others.length) {
    console.log("\n--- Fora da reconciliação ---");
    for (const r of others) console.log(`  ${r.sku.padEnd(16)} ${r.category.padEnd(12)} ${r.reason}`);
  }

  const outDir = path.join(process.cwd(), "results");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `price-reconcile-dry-run-${new Date().toISOString().slice(0, 10)}.csv`);
  const header = ["sku", "titulo", "custo", "pvpr", "antes", "depois", "delta", "lucro", "estado_preco", "regra_daria", "categoria", "motivo"];
  const lines = [header.join(",")];
  for (const r of rows.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category))) {
    lines.push(
      [
        r.sku,
        r.title,
        r.cost?.toFixed(2),
        r.pvpr?.toFixed(2),
        r.before?.toFixed(2),
        r.after?.toFixed(2),
        r.delta?.toFixed(2),
        r.profit?.toFixed(2),
        r.priceStatus,
        r.ruleWouldBe?.toFixed(2),
        r.category,
        r.reason,
      ]
        .map(csvCell)
        .join(",")
    );
  }
  fs.writeFileSync(outFile, lines.join("\n") + "\n");
  console.log(`\nLista completa: ${outFile}`);
  console.log("Nada foi escrito na Shopify. PARAR — aplicar só depois do OK do Carlos.");
}

main()
  .catch((err) => {
    console.error(err?.stack || err?.message || err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
