import { prisma, findManyConfirmed } from "../../prisma/prismaSafe.server.js";
import { tryPriceProduct, resolveMarginPct } from "../pricing/pricing.server.js";
import { loadShopSettings } from "../settings.server.js";

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
      totalProfitEur: 0,
      marginPct: null,
      statusCounts: {},
      priceErrorCount: 0,
      priceErrorSkus: [],
      missingCount: 0,
      missingSkus: [],
    };
  }

  // Margem global inválida lança — o resumo nunca mostra totais com uma margem inventada.
  const marginPct = resolveMarginPct(await loadShopSettings(shop));

  const rows = await findManyConfirmed(prisma.catalogProduct, {
    where: { shop, sku: { in: unique } },
    select: { sku: true, distributorPrice: true, grossPrice: true, title: true },
  });

  const foundSet = new Set(rows.map((r) => r.sku));
  const missingSkus = unique.filter((s) => !foundSet.has(s));

  // Custo = precio_distribuidores × 1,21; alvo = pricing.server.js, o mesmo preço que o
  // publisher escreve. SKUs sem preço calculável listados à parte, nunca somados a 0.
  let totalCostCents = 0;
  let totalTargetCents = 0;
  const priceErrorSkus = [];
  /** @type {Record<string, number>} MARGEM / TETO / ACIMA_PVPR / SEM_PVPR */
  const statusCounts = {};

  for (const row of rows) {
    const { finalPrice, cost, priceStatus, priceError } = tryPriceProduct(row.distributorPrice, row.grossPrice, marginPct);
    if (priceError) {
      priceErrorSkus.push(row.sku);
      continue;
    }
    totalCostCents += Math.round(cost * 100);
    totalTargetCents += Math.round(finalPrice * 100);
    statusCounts[priceStatus] = (statusCounts[priceStatus] || 0) + 1;
  }

  return {
    approvedCount: unique.length,
    foundCount: rows.length,
    totalCostEur: totalCostCents / 100,
    totalTargetRetailEur: totalTargetCents / 100,
    totalProfitEur: (totalTargetCents - totalCostCents) / 100,
    marginPct,
    statusCounts,
    // Contagens reais à parte das amostras de 50 — o modal mostra a contagem, nunca o
    // tamanho da amostra (revisão adversarial do PR #87).
    priceErrorCount: priceErrorSkus.length,
    priceErrorSkus: priceErrorSkus.slice(0, 50),
    missingCount: missingSkus.length,
    missingSkus: missingSkus.slice(0, 50),
  };
}
