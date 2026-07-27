import { prisma, safePrisma } from "../../prisma/prismaSafe.server.js";

const ORDERS_PAGE = `
  query SalesRadarOrders($cursor: String, $query: String!) {
    orders(first: 50, after: $cursor, query: $query, sortKey: CREATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          lineItems(first: 100) {
            edges {
              node {
                quantity
                sku
                variant { sku }
              }
            }
          }
        }
      }
    }
  }
`;

function salesQuerySince() {
  const since = new Date();
  since.setDate(since.getDate() - 30);
  return `created_at:>=${since.toISOString().slice(0, 10)}`;
}

/**
 * Agrega vendas (unidades) dos últimos 30 dias por SKU.
 * @param {import('../shopifyClient.js').ShopifyClient} client
 */
export async function fetchSalesBySkuLast30Days(client) {
  const query = salesQuerySince();
  /** @type {Record<string, number>} */
  const bySku = {};
  let cursor = null;
  let pages = 0;
  const maxPages = 40;

  while (pages < maxPages) {
    const data = await client.graphql(ORDERS_PAGE, { cursor, query });
    const conn = data?.orders;
    if (!conn) break;

    for (const edge of conn.edges || []) {
      for (const li of edge.node?.lineItems?.edges || []) {
        const node = li.node;
        const sku = (node?.sku || node?.variant?.sku || "").trim();
        if (!sku) continue;
        const qty = Number(node.quantity) || 0;
        bySku[sku] = (bySku[sku] || 0) + qty;
      }
    }

    pages += 1;
    if (!conn.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  return bySku;
}

/**
 * @param {string} shop
 * @param {import('../shopifyClient.js').ShopifyClient} client
 */
export async function refreshProductSalesSnapshot(shop, client) {
  const bySku = await fetchSalesBySkuLast30Days(client);
  const now = new Date();

  await safePrisma("productSalesSnapshot.deleteMany", () =>
    prisma.productSalesSnapshot.deleteMany({ where: { shop } })
  );

  const entries = Object.entries(bySku);
  const BATCH = 200;
  for (let i = 0; i < entries.length; i += BATCH) {
    const slice = entries.slice(i, i + BATCH);
    await safePrisma("productSalesSnapshot.createMany", () =>
      prisma.productSalesSnapshot.createMany({
        data: slice.map(([sku, unitsSold30d]) => ({
          shop,
          sku,
          unitsSold30d,
          updatedAt: now,
        })),
      })
    );
  }

  return { skusWithSales: entries.length, updatedAt: now.toISOString() };
}

/**
 * @param {string} shop
 * @param {string[]} skus
 */
export async function getSalesBySkus(shop, skus) {
  if (!skus.length) return {};
  const rows = await safePrisma("productSalesSnapshot.findMany", () =>
    prisma.productSalesSnapshot.findMany({
      where: { shop, sku: { in: skus } },
    }),
    { fallback: [] }
  );

  /** @type {Record<string, number>} */
  const map = {};
  for (const row of rows) {
    map[row.sku] = row.unitsSold30d;
  }
  return map;
}
