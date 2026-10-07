/**
 * Alerta de erosão de margem — refeito na revisão do dry-run de preços (07/10/2026).
 *
 * Em cada ciclo (api.trigger-sync, depois da indexação do feed) compara o preço LIVE de
 * cada produto PUBLISHED com o custo ATUAL do feed (precio_distribuidores × 1,21,
 * CatalogProduct.distributorPrice — o catálogo é reconstruído a partir do feed em cada
 * ciclo). Sem valor de referência guardado por produto: o custo mexe nos dois sentidos e
 * os publicados já não acompanham sozinhos (o publisher não reescreve preço no update).
 *
 *   margem efetiva = (preço live − custo) / custo        (margem sobre o custo)
 *   vermelho       = margem efetiva abaixo de MIN_MARGIN (10 %)
 *
 * Também lista, à parte, os PUBLISHED sem dados para medir (sem custo no catálogo, sem
 * variante live — com a causa), para nada ficar de fora em silêncio.
 *
 * Só reporta — nunca mexe em preço nem stock. A decisão fica com o Carlos.
 * Testado em scripts/tests/margin-erosion.test.js.
 */
import fs from "fs/promises";
import path from "path";
import { getDefaultConfig } from "../config.js";
import { prisma, findManyConfirmed } from "../../prisma/prismaSafe.server.js";
import { listCurationQueueItems } from "../../curation/curationQueue.server.js";
import { costCentsFromDistributor, MIN_MARGIN } from "../pricing/pricing.server.js";
import { fetchLiveVariantsBySku, diagnoseMissingLive } from "../shopify/liveVariantsBySku.server.js";

/** Abaixo disto (margem efetiva sobre o custo, em %), o produto fica vermelho. */
export const MARGIN_EROSION_RED_PCT = MIN_MARGIN;

/** Limite de SKUs por query IN — evita o limite de parâmetros do SQLite. */
const SKU_CHUNK_SIZE = 500;

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function statePath(shop) {
  return path.join(getDefaultConfig().paths.data, "margin-erosion", `${shop.replace(/\//g, "_")}.json`);
}

/**
 * Decisão pura (sem I/O).
 * @param {{
 *   published: { sku: string, title_en?: string|null }[],
 *   catalogBySku: Map<string, { distributorPrice: number|null, title?: string|null }>,
 *   liveBySku: Map<string, { price: number, title?: string|null, duplicate?: boolean }>,
 *   missingLiveReasons?: Map<string, string>,
 * }} input
 */
export function computeMarginErosion({ published, catalogBySku, liveBySku, missingLiveReasons = new Map() }) {
  const red = [];
  const noData = [];
  let measured = 0;

  for (const item of published) {
    const sku = item.sku;
    const cat = catalogBySku.get(sku);
    const live = liveBySku.get(sku);
    const title = live?.title || cat?.title || item.title_en || sku;

    if (!live) {
      noData.push({ sku, title, reason: missingLiveReasons.get(sku) || "sem variante live na Shopify" });
      continue;
    }
    if (live.duplicate) {
      noData.push({ sku, title, reason: "SKU em mais de uma variante live" });
      continue;
    }
    if (!cat) {
      noData.push({ sku, title, reason: "fora do catálogo indexado (saiu do feed?)" });
      continue;
    }
    const dist = Number(cat.distributorPrice);
    if (cat.distributorPrice == null || !Number.isFinite(dist) || dist <= 0) {
      noData.push({ sku, title, reason: "sem precio_distribuidores no catálogo" });
      continue;
    }

    const costCents = costCentsFromDistributor(Math.round(dist * 100));
    const liveCents = Math.round(live.price * 100);
    const effectiveMarginPct = Math.round(((liveCents - costCents) / costCents) * 1000) / 10;
    measured += 1;
    if (effectiveMarginPct < MARGIN_EROSION_RED_PCT) {
      red.push({
        sku,
        title,
        livePrice: liveCents / 100,
        cost: costCents / 100,
        effectiveMarginPct,
      });
    }
  }

  red.sort((a, b) => a.effectiveMarginPct - b.effectiveMarginPct);
  return { red, noData, measured };
}

/**
 * Ciclo: lê fila, catálogo e Shopify, decide, grava o estado. Leitura falhada lança —
 * o chamador (api.trigger-sync) regista; nunca grava um estado verde falso.
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} shop
 */
export async function reconcileMarginErosionCycle(client, shop) {
  const published = (await listCurationQueueItems("PUBLISHED")).filter((i) => i.sku);
  const skus = published.map((i) => i.sku);

  const catalogBySku = new Map();
  for (const chunk of chunkArray(skus, SKU_CHUNK_SIZE)) {
    const rows = await findManyConfirmed(prisma.catalogProduct, {
      where: { shop, sku: { in: chunk } },
      select: { sku: true, title: true, distributorPrice: true },
    });
    for (const r of rows) catalogBySku.set(r.sku, r);
  }

  const liveBySku = await fetchLiveVariantsBySku(client, skus);
  const orphans = published.filter((i) => !liveBySku.has(i.sku));
  const missingLiveReasons = await diagnoseMissingLive(client, orphans);

  const { red, noData, measured } = computeMarginErosion({ published, catalogBySku, liveBySku, missingLiveReasons });
  const state = {
    status: red.length ? "red" : noData.length ? "yellow" : "green",
    shop,
    ranAt: new Date().toISOString(),
    thresholdPct: MARGIN_EROSION_RED_PCT,
    publishedCount: published.length,
    measured,
    red,
    noData,
  };
  const file = statePath(shop);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(state, null, 2), "utf8");
  return state;
}

/**
 * Último estado gravado (painel de Relatórios). null = ainda nenhum ciclo correu.
 * @param {string} shop
 */
export async function loadMarginErosionState(shop) {
  try {
    return JSON.parse(await fs.readFile(statePath(shop), "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw new Error(`FALHA DE LEITURA (${statePath(shop)}): ${err?.message || err}`);
  }
}
