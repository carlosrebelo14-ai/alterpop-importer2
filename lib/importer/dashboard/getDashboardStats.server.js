import { prisma, safePrisma } from "../../prisma/prismaSafe.server.js";
import { loadCurationQueue } from "../../curation/curationQueue.server.js";

/**
 * Fonte única de verdade — contagens reais para o Dashboard.
 * @param {string} shop
 */
export async function getDashboardStats(shop) {
  const totalIndexed = await safePrisma(
    "dashboard.catalogProduct.count",
    () => prisma.catalogProduct.count({ where: { shop } }),
    { fallback: 0 }
  );

  const catalogRows = await safePrisma(
    "dashboard.catalogProduct.skus",
    () => prisma.catalogProduct.findMany({ where: { shop }, select: { sku: true } }),
    { fallback: [] }
  );
  const catalogSkuSet = new Set(catalogRows.map((r) => r.sku));

  const queue = await loadCurationQueue();
  let totalApproved = 0;
  let totalRejected = 0;
  let totalPending = 0;
  let totalPublished = 0;
  let totalSyncError = 0;
  const approvedSkus = [];

  for (const item of queue.items) {
    if (!catalogSkuSet.has(item.sku)) continue;
    if (item.status === "APPROVED") {
      totalApproved += 1;
      approvedSkus.push(item.sku);
    }
    else if (item.status === "REJECTED") totalRejected += 1;
    else if (item.status === "PENDING") totalPending += 1;
    else if (item.status === "PUBLISHED") totalPublished += 1;
    else if (item.status === "SYNC_ERROR") totalSyncError += 1;
  }

  const withoutDecision = Math.max(
    0,
    totalIndexed -
      totalApproved -
      totalRejected -
      totalPending -
      totalPublished -
      totalSyncError
  );

  const inventoryAgg = await safePrisma(
    "dashboard.catalogProduct.stockSum",
    () =>
      prisma.catalogProduct.aggregate({
        where: { shop },
        _sum: { stock: true },
      }),
    { fallback: { _sum: { stock: 0 } } }
  );
  const inventoryVolume = Number(inventoryAgg?._sum?.stock || 0);

  let totalPotentialRevenue = 0;
  let estimatedNetProfit = 0;
  if (approvedSkus.length) {
    const approvedRows = await safePrisma(
      "dashboard.catalogProduct.approvedRows",
      () =>
        prisma.catalogProduct.findMany({
          where: { shop, sku: { in: approvedSkus } },
          select: { netPrice: true },
        }),
      { fallback: [] }
    );
    const netSum = approvedRows.reduce(
      (sum, row) => sum + (Number(row.netPrice) > 0 ? Number(row.netPrice) : 0),
      0
    );
    totalPotentialRevenue = Math.round(netSum * 1.4 * 100) / 100;
    estimatedNetProfit = Math.round(netSum * 0.4 * 100) / 100;
  }

  const syncBase = totalPublished + totalSyncError;
  const syncHealthRate = syncBase > 0 ? totalPublished / syncBase : 1;

  return {
    shop,
    totalIndexed,
    totalApproved,
    totalRejected,
    totalPending,
    totalPublished,
    totalSyncError,
    totalPotentialRevenue,
    estimatedNetProfit,
    inventoryVolume,
    syncHealthRate,
    withoutDecision,
    updatedAt: new Date().toISOString(),
  };
}
