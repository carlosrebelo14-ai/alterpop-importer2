import { prisma, findManyConfirmed } from "../../prisma/prismaSafe.server.js";
import { computeTargetRetailPrice } from "../pricing/targetRetail.server.js";

const MARGIN = 0.4;

/**
 * Resumo de staging antes de sincronizar SKUs aprovados.
 *
 * Briefing "Leitura confirmada" (Decisão 30) — antes, a leitura usava `safePrisma`
 * com `fallback: []`: um erro de query virava "todos os SKUs em falta", mostrado ao
 * operador mesmo antes de publicar (o mesmo sintoma do Incidente 1, censado como
 * BLOCKING em docs/db-read-safety-census.md). Agora lança em vez de degradar — o
 * chamador (loader da API) apanha o erro e devolve um estado explícito, nunca um
 * resumo com secções em falta ou um `missingSkus` mentiroso.
 *
 * @param {string} shop
 * @param {string[]} skus
 */
export async function computeSyncStagingSummary(shop, skus) {
  const unique = [...new Set(skus.map((s) => String(s).trim()).filter(Boolean))];
  if (!unique.length) {
    return {
      approvedCount: 0,
      foundCount: 0,
      totalCostEur: 0,
      totalTargetRetailEur: 0,
      averageMarginPercent: null,
      missingSkus: [],
    };
  }

  const rows = await findManyConfirmed(prisma.catalogProduct, {
    where: { shop, sku: { in: unique } },
    select: { sku: true, netPrice: true, title: true },
  });

  const foundSet = new Set(rows.map((r) => r.sku));
  const missingSkus = unique.filter((s) => !foundSet.has(s));

  let totalCost = 0;
  let totalTarget = 0;
  let marginSum = 0;
  let marginCount = 0;

  for (const row of rows) {
    const cost = row.netPrice != null ? Number(row.netPrice) : 0;
    if (cost > 0) {
      totalCost += cost;
      const target = computeTargetRetailPrice(cost) ?? 0;
      totalTarget += target;
      marginSum += MARGIN * 100;
      marginCount += 1;
    }
  }

  const averageMarginPercent =
    marginCount > 0 ? Math.round((marginSum / marginCount) * 10) / 10 : null;

  return {
    approvedCount: unique.length,
    foundCount: rows.length,
    totalCostEur: Math.round(totalCost * 100) / 100,
    totalTargetRetailEur: Math.round(totalTarget * 100) / 100,
    averageMarginPercent,
    missingSkus: missingSkus.slice(0, 50),
  };
}
