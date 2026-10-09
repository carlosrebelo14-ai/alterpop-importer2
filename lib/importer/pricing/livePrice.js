/**
 * Preço live vs preço calculado, por linha PUBLISHED do painel (briefing de integridade,
 * 09/10/2026, A3). O painel mostra o número que a loja tem; o calculado só aparece como
 * aviso quando difere. Função pura — a leitura da Shopify está em livePricePanel.server.js.
 *
 * liveState:
 *   ok       live bate com o calculado, ao cêntimo
 *   differs  live difere do calculado (selo amarelo)
 *   no_rule  há preço live mas não há preço calculado (priceError)
 *   missing  PUBLISHED sem variante live com este SKU
 *   unread   a leitura da Shopify falhou — nunca se esconde, nunca se assume "ok"
 *   null     linha que não é PUBLISHED: não se compara
 */

const cents = (v) => Math.round(Number(v) * 100);

/**
 * @param {{ queueStatus?: string|null, finalPrice: number|null, cost: number|null,
 *   live?: { price: number }|null, readError?: string|null }} args
 * @returns {{ liveState: string|null, livePrice: number|null, liveProfit: number|null, liveError: string|null }}
 */
export function compareLivePrice({ queueStatus, finalPrice, cost, live, readError }) {
  const none = { liveState: null, livePrice: null, liveProfit: null, liveError: null };
  if (queueStatus !== "PUBLISHED") return none;
  if (readError) return { ...none, liveState: "unread", liveError: readError };
  if (!live || !Number.isFinite(Number(live.price))) return { ...none, liveState: "missing" };

  const livePrice = Number(live.price);
  const liveProfit = cost != null ? Math.round((livePrice - cost) * 100) / 100 : null;
  let liveState;
  if (finalPrice == null) liveState = "no_rule";
  else liveState = cents(livePrice) === cents(finalPrice) ? "ok" : "differs";
  return { liveState, livePrice, liveProfit, liveError: null };
}
