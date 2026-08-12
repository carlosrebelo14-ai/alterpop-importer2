import { prisma, safePrisma } from "../../prisma/prismaSafe.server.js";
import { loadCurationQueue } from "../../curation/curationQueue.server.js";

/**
 * Versão super-leve para polling frequente (Curadoria repete isto a cada 5-15s
 * enquanto a página está aberta). NÃO lê curation-queue.json — só um COUNT e uma
 * query indexada em SyncErrorLog. Medido em produção: ~10-15ms, contra ~800ms da
 * versão completa que corria antes a cada ciclo de poll.
 * @param {string} shop
 */
export async function getPollStats(shop) {
  const [totalIndexed, syncErrorSkus] = await Promise.all([
    safePrisma(
      "dashboard.catalogProduct.count",
      () => prisma.catalogProduct.count({ where: { shop } }),
      { fallback: 0 }
    ),
    safePrisma(
      "dashboard.syncErrorLog.distinctSkus",
      () =>
        prisma.syncErrorLog.findMany({
          where: { shop, active: true },
          select: { sku: true },
          distinct: ["sku"],
        }),
      { fallback: [] }
    ),
  ]);

  return { totalIndexed, totalSyncError: syncErrorSkus.length };
}

/**
 * Versão leve para o load inicial da Curadoria (/app) e para o refresh depois de
 * aprovar/rejeitar. A Curadoria mostra "Aprovados/Rejeitados/Pendentes", que só
 * existem na fila de curadoria — por isso ainda lê curation-queue.json (não há como
 * evitar sem mudar onde o estado de curadoria vive). O que poupa face a
 * getDashboardStats(): não calcula receita potencial, lucro estimado, volume de
 * inventário, saúde de sync nem preço médio — nada disso é usado fora de /app/reports.
 * @param {string} shop
 */
export async function getCurationLiteStats(shop) {
  try {
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
    const catalogSkuSet = new Set((catalogRows || []).map((r) => r.sku));

    const queue = await loadCurationQueue();
    let totalApproved = 0;
    let totalRejected = 0;
    let totalPending = 0;
    let totalSyncError = 0;

    for (const item of queue?.items || []) {
      if (!catalogSkuSet.has(item.sku)) continue;
      if (item.status === "APPROVED") totalApproved += 1;
      else if (item.status === "REJECTED") totalRejected += 1;
      else if (item.status === "PENDING") totalPending += 1;
      else if (item.status === "SYNC_ERROR") totalSyncError += 1;
    }

    return { totalIndexed, totalApproved, totalRejected, totalPending, totalSyncError };
  } catch (err) {
    console.error("[getCurationLiteStats] Error, returning fallback:", err?.message || err);
    return { totalIndexed: 0, totalApproved: 0, totalRejected: 0, totalPending: 0, totalSyncError: 0 };
  }
}

/**
 * Fonte única de verdade — contagens reais para o Dashboard.
 * @param {string} shop
 */
export async function getDashboardStats(shop) {
  const defaultStats = {
    shop,
    totalIndexed: 0,
    totalApproved: 0,
    totalRejected: 0,
    totalPending: 0,
    totalPublished: 0,
    totalSyncError: 0,
    totalPotentialRevenue: 0,
    estimatedNetProfit: 0,
    inventoryVolume: 0,
    syncHealthRate: 1,
    withoutDecision: 0,
    approvalRate: 0,
    avgApprovedNetPrice: 0,
    updatedAt: new Date().toISOString(),
  };

  try {
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
    const catalogSkuSet = new Set((catalogRows || []).map((r) => r.sku));

    const queue = await loadCurationQueue();
    let totalApproved = 0;
    let totalRejected = 0;
    let totalPending = 0;
    let totalPublished = 0;
    let totalSyncError = 0;
    const approvedSkus = [];

    for (const item of (queue?.items || [])) {
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
    let avgApprovedNetPrice = 0;
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
      const validRows = (approvedRows || []).filter((r) => Number(r?.netPrice) > 0);
      const netSum = validRows.reduce((sum, row) => sum + Number(row.netPrice), 0);
      
      totalPotentialRevenue = Math.round(netSum * 1.4 * 100) / 100;
      estimatedNetProfit = Math.round(netSum * 0.4 * 100) / 100;
      avgApprovedNetPrice = validRows.length > 0 ? Math.round((netSum / validRows.length) * 100) / 100 : 0;
    }

    const syncBase = totalPublished + totalSyncError;
    const syncHealthRate = syncBase > 0 ? totalPublished / syncBase : 1;

    const decisionsCount = totalApproved + totalRejected;
    const approvalRate = decisionsCount > 0 ? totalApproved / decisionsCount : 0;

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
      approvalRate,
      avgApprovedNetPrice,
      updatedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.error("[getDashboardStats] Error getting stats, returning fallback:", err?.message || err);
    return defaultStats;
  }
}
