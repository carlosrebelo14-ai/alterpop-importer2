import { authenticate } from "../shopify.server";
import { prisma, safePrisma } from "../../lib/prisma/prismaSafe.server.js";

/**
 * Item 18 do roadmap — heurística de encomenda sem stock. NÃO cancela nada,
 * NÃO chama a API do fornecedor (não temos essa integração em tempo real,
 * já confirmado antes). Compara só contra o stock indexado localmente, que
 * pode estar desactualizado até 45 min (próximo ciclo do relógio) — falsos
 * positivos/negativos são esperados, por isso isto é só um alerta manual,
 * não uma confirmação.
 */
export const action = async ({ request }) => {
  const { shop, payload, topic } = await authenticate.webhook(request);

  console.log(`[orders-webhook] ${topic} para ${shop}, order ${payload?.name || payload?.id}`);

  const lineItems = Array.isArray(payload?.line_items) ? payload.line_items : [];
  const skus = lineItems.map((li) => li.sku).filter(Boolean);

  if (!skus.length) {
    return new Response();
  }

  const catalogRows = await safePrisma("orderStockAlert.lookupCatalog", () =>
    prisma.catalogProduct.findMany({
      where: { shop, sku: { in: skus } },
      select: { sku: true, stock: true },
    }),
    { fallback: [] }
  );
  const stockBySku = new Map(catalogRows.map((r) => [r.sku, r.stock]));

  const orderId = String(payload.id);
  const orderName = payload.name || `#${payload.order_number || payload.id}`;

  const alerts = [];
  for (const li of lineItems) {
    if (!li.sku) continue;
    const orderedQty = Number(li.quantity) || 0;
    // SKU sem entrada no catálogo indexado tratado como stock 0 — mais provável
    // ser um produto descontinuado/mal indexado do que stock real desconhecido.
    const indexedStock = stockBySku.has(li.sku) ? stockBySku.get(li.sku) : 0;
    if (orderedQty > indexedStock) {
      alerts.push({
        shop,
        orderId,
        orderName,
        sku: li.sku,
        orderedQty,
        indexedStock,
      });
    }
  }

  if (alerts.length) {
    await safePrisma("orderStockAlert.create", () =>
      prisma.orderStockAlert.createMany({ data: alerts })
    );
    console.warn(
      `[orders-webhook] ${alerts.length} SKU(s) da encomenda ${orderName} podem estar sem stock (heurística sobre índice local, até 45min desactualizado)`
    );
  }

  return new Response();
};
