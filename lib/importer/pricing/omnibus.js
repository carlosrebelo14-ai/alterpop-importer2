/**
 * Preço riscado Omnibus — mínimo dos preços praticados nos 30 dias anteriores (Decisão 31).
 * Módulo puro, sem I/O: a leitura do histórico está em priceHistory.server.js.
 *
 * Só CALCULA e expõe (omnibusMinCents em /api/products): a app não escreve compareAtPrice na
 * Shopify. O histórico guarda o preço enviado com a regra com que foi calculado (LEGACY com
 * IVA, NET sem IVA); só contam as entradas da regra em vigor, nunca se misturam as duas.
 */

export const OMNIBUS_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Mínimo dos preços da regra pedida em vigor em algum momento da janela [now − 30 dias, now]:
 * as entradas dentro da janela e a última anterior a ela (o preço que já estava em vigor
 * quando a janela começou). Sem entradas dessa regra devolve null.
 * @param {Array<{ priceCents: number, rule: string, at: string|Date }>} history
 * @param {Date} now
 * @param {"NET"|"LEGACY"} rule
 * @param {number} [windowDays]
 * @returns {number|null} cêntimos
 */
export function omnibusMinCents(history, now, rule, windowDays = OMNIBUS_WINDOW_DAYS) {
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw new Error(`omnibusMinCents: data inválida (${now})`);
  const startMs = nowMs - windowDays * DAY_MS;

  const entries = [];
  for (const h of history || []) {
    if (h.rule !== rule) continue;
    const at = h.at instanceof Date ? h.at.getTime() : new Date(h.at).getTime();
    if (!Number.isFinite(at) || at > nowMs) continue; // futuro ou data inválida: não conta
    if (!Number.isInteger(h.priceCents) || h.priceCents <= 0) continue;
    entries.push({ at, priceCents: h.priceCents });
  }
  if (!entries.length) return null;
  entries.sort((a, b) => a.at - b.at);

  let min = null;
  let inForceAtStart = null;
  for (const e of entries) {
    if (e.at <= startMs) inForceAtStart = e.priceCents; // última anterior ao início da janela
    else min = min == null ? e.priceCents : Math.min(min, e.priceCents);
  }
  if (inForceAtStart != null) min = min == null ? inForceAtStart : Math.min(min, inForceAtStart);
  return min;
}
