import { prisma, safePrisma } from "../../prisma/prismaSafe.server.js";
import { resolveVariantBySku } from "../lib/resolveSku.js";
import { syncCatalogStockToShopify } from "./shopifyInventorySync.server.js";
import { resolveLocationId } from "../shopifyClient.js";
import { listCurationQueueItems } from "../../curation/curationQueue.server.js";

const INVENTORY_QUANTITY_QUERY = `
  query GetInventoryQty($inventoryItemId: ID!, $locationId: ID!) {
    inventoryItem(id: $inventoryItemId) {
      inventoryLevel(locationId: $locationId) {
        quantities(names: ["available"]) {
          name
          quantity
        }
      }
    }
  }
`;

/**
 * Mecanismo dedicado só para stock de produtos já PUBLISHED (item 18b do roadmap).
 *
 * runApprovedShopifySync() só processa itens com status APPROVED — assim que um
 * produto passa a PUBLISHED (markQueueItemPublished), sai definitivamente do radar
 * do sync automático. Um produto que esgota e o fornecedor repõe stock ficava preso
 * a "sem stock" na Shopify até alguém o reaprovar manualmente (confirmado por
 * investigação em produção, 2026-08-13: 208 PUBLISHED, 0 APPROVED — o próximo ciclo
 * não tocaria em nenhum).
 *
 * Deliberadamente NÃO chama publishCatalogProductToShopify() nem productUpdate — só
 * a mutação de inventory, para nunca sobrescrever título/preço/categoria/descrição
 * que o Carlos possa ter editado à mão num produto já publicado. sync_locked
 * (item 15) não é verificado aqui de propósito: esse metafield protege só conteúdo,
 * o design do item 15 já deixa o stock a sincronizar sempre, trancado ou não.
 *
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} shop
 * @param {{ locationId?: string, stockBuffer?: number }} [opts]
 * @returns {Promise<{ checked: number, updated: number, skipped: number, failed: number, failures: {sku:string, message:string}[] }>}
 */
export async function syncPublishedStockLevels(client, shop, opts = {}) {
  const publishedItems = await listCurationQueueItems("PUBLISHED");
  const skus = publishedItems.map((i) => i.sku).filter(Boolean);

  const result = { checked: 0, updated: 0, skipped: 0, failed: 0, failures: [] };
  if (!skus.length) return result;

  const catalogRows = await safePrisma("publishedStockSync.loadRows", () =>
    prisma.catalogProduct.findMany({
      where: { shop, sku: { in: skus } },
      select: { sku: true, stock: true },
    }),
    { fallback: [] }
  );
  const stockBySku = new Map(catalogRows.map((r) => [r.sku, r.stock]));

  const locationId = opts.locationId || (await resolveLocationId(client, process.env.SHOPIFY_LOCATION_ID));
  const buffer = Number.isFinite(Number(opts.stockBuffer)) ? Math.max(0, Number(opts.stockBuffer)) : 0;
  const variantCache = new Map();

  for (const sku of skus) {
    result.checked += 1;

    // SKU publicado mas já não indexado localmente (ex: descontinuado pelo
    // fornecedor) — não há stock local fiável para comparar, salta em vez de
    // adivinhar um valor.
    if (!stockBySku.has(sku)) {
      result.skipped += 1;
      continue;
    }

    try {
      const variant = await resolveVariantBySku(client, sku, variantCache);
      if (!variant?.inventoryItem?.id || !variant?.product?.id) {
        result.failed += 1;
        result.failures.push({ sku, message: "Produto/variante não encontrado na Shopify" });
        continue;
      }

      const localStock = stockBySku.get(sku) ?? 0;
      const targetQty = Math.max(0, Math.floor(Number(localStock) || 0) - buffer);

      const currentData = await client.graphql(INVENTORY_QUANTITY_QUERY, {
        inventoryItemId: variant.inventoryItem.id,
        locationId,
      });
      const currentQty =
        currentData.inventoryItem?.inventoryLevel?.quantities?.find((q) => q.name === "available")
          ?.quantity ?? null;

      // Já bate certo (ou o nível de inventory ainda não existe nesta location e o
      // alvo é 0 — não vale a pena criar um nível só para dizer "zero") — não faz a
      // chamada de escrita. É este passo que evita chamadas desnecessárias quando o
      // stock não mudou (achado do item 4 do pedido).
      if (currentQty === targetQty || (currentQty === null && targetQty === 0)) {
        result.skipped += 1;
        continue;
      }

      await syncCatalogStockToShopify(client, {
        productId: variant.product.id,
        variantId: variant.id,
        inventoryItemId: variant.inventoryItem.id,
        stock: localStock,
        locationId,
        stockBuffer: buffer,
      });
      result.updated += 1;
    } catch (err) {
      result.failed += 1;
      result.failures.push({ sku, message: err?.message || String(err) });
    }
  }

  return result;
}
