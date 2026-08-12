/**
 * Ciclo de vida do SKU no feed OcioStock — itens 2 e 3 do pacote de melhorias
 * criativas de 2026-08-12 (deteção de novidades / descontinuados).
 *
 * CatalogProduct é limpo e reconstruído em cada ciclo do relógio (ver
 * syncCatalogWithProgress `clearFirst`), por isso não dá para comparar "SKUs deste
 * ciclo" com "SKUs do ciclo anterior" olhando só para essa tabela. CatalogSkuTracking
 * (schema.prisma) é a tabela que sobrevive entre ciclos e guarda esse histórico.
 *
 * Chamado UMA VEZ no fim de cada ciclo completo (não resumido) de indexação —
 * ver indexingStream.server.js. Nunca corre sobre um resume parcial, porque nesse
 * caso o CSV não foi lido do início e "SKU ausente" não significaria nada.
 */
import { prisma, safePrisma } from "../../prisma/prismaSafe.server.js";
import { loadMarketSettings } from "../curation/dynamicRules.server.js";

/** Ciclos consecutivos sem aparecer no CSV antes de marcar para revisão (~2h15 a 45min/ciclo). */
export const DISCONTINUED_THRESHOLD = 3;

/** Limite de itens guardados por relatório de ciclo — evita JSON gigante se um feed mudar radicalmente. */
const REPORT_LIST_CAP = 200;

const CHUNK = 300;

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function parseFranchises(raw) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * @param {{ vendor?: string|null, franchises?: string[] }} product
 * @param {{ vipBrands: string[], vipLicences: string[] }} vipConfig
 */
function isVip(product, vipConfig) {
  const vendorLower = String(product.vendor || "").toLowerCase();
  if (vipConfig.vipBrands.some((b) => vendorLower.includes(b.toLowerCase()))) return true;
  const franchisesLower = (product.franchises || []).map((f) => String(f).toLowerCase());
  return vipConfig.vipLicences.some((lic) =>
    franchisesLower.some((f) => f.includes(lic.toLowerCase()))
  );
}

/**
 * Corre a comparação de ciclo — chamar depois de um `syncCatalogWithProgress` completo
 * e não-resumido. Nunca lança: falhas aqui não devem impedir o publish do ciclo.
 * @param {string} shop
 */
export async function runSkuLifecycleCycle(shop) {
  try {
    const [currentRows, trackingRows] = await Promise.all([
      safePrisma("skuLifecycle.currentRows", () =>
        prisma.catalogProduct.findMany({
          where: { shop },
          select: { sku: true, vendor: true, franchises: true },
        })
      ),
      safePrisma("skuLifecycle.trackingRows", () =>
        prisma.catalogSkuTracking.findMany({
          where: { shop },
          select: { sku: true, status: true, missingCycles: true },
        })
      ),
    ]);

    const currentBySku = new Map(currentRows.map((r) => [r.sku, r]));
    const trackedSkus = new Set(trackingRows.map((r) => r.sku));

    const newSkus = currentRows.filter((r) => !trackedSkus.has(r.sku));
    const stillPresentSkus = trackingRows.filter((r) => currentBySku.has(r.sku)).map((r) => r.sku);
    const missingRows = trackingRows.filter((r) => !currentBySku.has(r.sku));

    const vipConfig = loadMarketSettings(shop);
    const now = new Date();

    // Novos SKUs — insert em lote (createMany ignora duplicados por segurança, embora
    // não devessem existir já que vêm de fora de trackedSkus).
    if (newSkus.length) {
      await safePrisma("skuLifecycle.insertNew", () =>
        prisma.catalogSkuTracking.createMany({
          data: newSkus.map((r) => ({
            shop,
            sku: r.sku,
            vendor: r.vendor || null,
            franchises: r.franchises || "[]",
            firstSeenAt: now,
            lastSeenAt: now,
            missingCycles: 0,
            status: "active",
          })),
          skipDuplicates: true,
        })
      );
    }

    // SKUs que continuam a aparecer — reset de missingCycles, sai de "review" se lá estava.
    for (const chunk of chunkArray(stillPresentSkus, CHUNK)) {
      await safePrisma("skuLifecycle.touchPresent", () =>
        prisma.$executeRawUnsafe(
          `UPDATE CatalogSkuTracking
           SET lastSeenAt = ?, missingCycles = 0,
               status = CASE WHEN status = 'review' THEN 'active' ELSE status END,
               vendor = COALESCE((SELECT vendor FROM CatalogProduct WHERE CatalogProduct.shop = CatalogSkuTracking.shop AND CatalogProduct.sku = CatalogSkuTracking.sku), vendor)
           WHERE shop = ? AND sku IN (${chunk.map(() => "?").join(",")})`,
          now.toISOString(),
          shop,
          ...chunk
        )
      );
    }

    // SKUs ausentes deste ciclo — incrementa contador, marca para revisão ao 3.º ciclo seguido.
    const missingSkus = missingRows.map((r) => r.sku);
    for (const chunk of chunkArray(missingSkus, CHUNK)) {
      await safePrisma("skuLifecycle.touchMissing", () =>
        prisma.$executeRawUnsafe(
          `UPDATE CatalogSkuTracking
           SET missingCycles = missingCycles + 1,
               status = CASE WHEN missingCycles + 1 >= ? THEN 'review' ELSE status END
           WHERE shop = ? AND sku IN (${chunk.map(() => "?").join(",")})`,
          DISCONTINUED_THRESHOLD,
          shop,
          ...chunk
        )
      );
    }

    const newVipSkus = newSkus
      .filter((r) => isVip(r, vipConfig))
      .slice(0, REPORT_LIST_CAP)
      .map((r) => ({ sku: r.sku, vendor: r.vendor || null, franchises: parseFranchises(r.franchises) }));

    const newlyReviewRows = missingRows.filter((r) => (r.missingCycles || 0) + 1 >= DISCONTINUED_THRESHOLD);
    const discontinuedReviewList = newlyReviewRows.slice(0, REPORT_LIST_CAP).map((r) => ({
      sku: r.sku,
      missingCycles: (r.missingCycles || 0) + 1,
    }));

    const report = await safePrisma("skuLifecycle.saveReport", () =>
      prisma.skuLifecycleCycleReport.create({
        data: {
          shop,
          ranAt: now,
          newSkuCount: newSkus.length,
          newVipSkusJson: JSON.stringify(newVipSkus),
          discontinuedReviewCount: newlyReviewRows.length,
          discontinuedReviewJson: JSON.stringify(discontinuedReviewList),
        },
      })
    );

    console.log(
      `[skuLifecycle] ${shop}: ${newSkus.length} novos SKUs (${newVipSkus.length} VIP), ` +
        `${newlyReviewRows.length} passaram a "para revisão" (${DISCONTINUED_THRESHOLD}+ ciclos ausentes).`
    );

    return report;
  } catch (err) {
    console.error("[skuLifecycle] ciclo falhou (não fatal):", err?.message || err);
    return null;
  }
}

/** @param {string} shop */
export async function getLatestLifecycleReport(shop) {
  const row = await safePrisma("skuLifecycle.latest", () =>
    prisma.skuLifecycleCycleReport.findFirst({
      where: { shop },
      orderBy: { ranAt: "desc" },
    }),
    { rethrow: false, fallback: null }
  );
  if (!row) return null;
  return {
    ranAt: row.ranAt,
    newSkuCount: row.newSkuCount,
    newVipSkus: JSON.parse(row.newVipSkusJson || "[]"),
    discontinuedReviewCount: row.discontinuedReviewCount,
    discontinuedReview: JSON.parse(row.discontinuedReviewJson || "[]"),
  };
}

/** Todos os SKUs atualmente marcados "para revisão" (não só os do último ciclo) — para Relatórios. */
export async function listSkusForReview(shop) {
  const rows = await safePrisma("skuLifecycle.listReview", () =>
    prisma.catalogSkuTracking.findMany({
      where: { shop, status: "review" },
      orderBy: { lastSeenAt: "asc" },
      take: 500,
    }),
    { rethrow: false, fallback: [] }
  );
  return rows.map((r) => ({
    sku: r.sku,
    vendor: r.vendor,
    missingCycles: r.missingCycles,
    lastSeenAt: r.lastSeenAt,
  }));
}
