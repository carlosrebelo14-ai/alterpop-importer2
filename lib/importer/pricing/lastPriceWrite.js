/**
 * Última escrita de preço por produto (briefing "Aplicar aos publicados", passo 1).
 *
 * Cada vez que a app escreve um preço numa variante da Shopify, regista-se em
 * `item.metadata.lastPriceWrite` o que escreveu e porquê: preço, custo, PVPR, margem,
 * estado do preço e data. Dois usos:
 *   - preço manual = preço live diferente do último que a app escreveu (isManualPrice);
 *   - o motivo de uma mudança proposta: margem, custo ou PVPR alterados (changeReasons).
 * É também a base de um futuro preço riscado / histórico Omnibus.
 *
 * Módulo puro, sem I/O: a gravação na fila é de curationQueue.server.js.
 */

/** Quem escreveu: o publisher, a página Import, a reconciliação, a ação "aplicar aos publicados" ou o preenchimento inicial. */
export const PRICE_WRITE_SOURCES = Object.freeze(["publisher", "reprice", "backfill", "import", "reconcile"]);

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const cents = (n) => Math.round(Number(n) * 100);

/**
 * @typedef {{
 *   price: number, cost: number|null, pvpr: number|null, marginPct: number|null,
 *   priceStatus: string|null, source: 'publisher'|'reprice'|'backfill'|'import'|'reconcile', at: string,
 *   marginInferred?: boolean,
 * }} LastPriceWrite
 */

/**
 * Valida e normaliza um registo. Preço inválido lança: um registo que não diz o que foi
 * escrito estragava a distinção entre preço manual e preço da app, e nada falha em silêncio.
 * @param {{ price: number|string, cost?: number|null, pvpr?: number|null, marginPct?: number|null,
 *   priceStatus?: string|null, source: string, at?: string|Date, marginInferred?: boolean }} w
 * @returns {LastPriceWrite}
 */
export function buildLastPriceWrite(w) {
  const price = Number(w?.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Última escrita inválida: preço ${JSON.stringify(w?.price)}`);
  }
  if (!PRICE_WRITE_SOURCES.includes(w.source)) {
    throw new Error(`Última escrita inválida: origem ${JSON.stringify(w.source)}`);
  }
  const at = w.at instanceof Date ? w.at.toISOString() : w.at || new Date().toISOString();
  if (Number.isNaN(new Date(at).getTime())) throw new Error(`Última escrita inválida: data ${JSON.stringify(w.at)}`);
  const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : round2(v));
  return {
    price: round2(price),
    cost: num(w.cost),
    pvpr: num(w.pvpr),
    marginPct: w.marginPct == null || !Number.isFinite(Number(w.marginPct)) ? null : Number(w.marginPct),
    priceStatus: w.priceStatus || null,
    source: w.source,
    at,
    ...(w.marginInferred ? { marginInferred: true } : {}),
  };
}

/**
 * Preço manual: o da loja já não é o último que a app escreveu. Sem registo, não se sabe —
 * devolve null (o chamador exclui com a razão "sem última escrita", nunca assume o contrário).
 * @param {LastPriceWrite|null|undefined} last
 * @param {number|string} livePrice
 * @returns {boolean|null}
 */
export function isManualPrice(last, livePrice) {
  if (!last || last.price == null) return null;
  return cents(livePrice) !== cents(last.price);
}

/**
 * Porque é que a regra propõe outro preço: o que mudou desde a última escrita. Se a margem
 * de origem foi estimada (marginInferred), o texto não o diz: a linha da pré-visualização
 * leva a marca à parte.
 * @param {LastPriceWrite|null|undefined} last
 * @param {{ cost: number|null, pvpr: number|null, marginPct: number|null }} now
 * @returns {string[]} frases, da mais para a menos relevante; vazio se nada mudou
 */
export function changeReasons(last, now) {
  if (!last) return ["sem última escrita registada"];
  const reasons = [];
  if (last.marginPct != null && now.marginPct != null && last.marginPct !== now.marginPct) {
    reasons.push(`margem alterada (de ${last.marginPct} para ${now.marginPct})`);
  } else if (last.marginPct == null && now.marginPct != null) {
    reasons.push(`margem de origem desconhecida (agora ${now.marginPct})`);
  }
  if (last.cost != null && now.cost != null && cents(last.cost) !== cents(now.cost)) {
    reasons.push(`custo alterado (de ${last.cost.toFixed(2)} para ${Number(now.cost).toFixed(2)})`);
  }
  if (last.pvpr != null && now.pvpr != null && cents(last.pvpr) !== cents(now.pvpr)) {
    reasons.push(`PVPR alterado (de ${last.pvpr.toFixed(2)} para ${Number(now.pvpr).toFixed(2)})`);
  }
  return reasons;
}

/**
 * Preenchimento inicial: a margem que explica um preço live, quando a regra a reproduz.
 * O preço da regra sobe em degraus (,50 e ,90) e tem piso e teto, por isso várias margens
 * inteiras (5 a 100) dão o mesmo preço: o Gandalf a 14,90 corresponde a 20, 21, 22 e 23.
 * Devolve o intervalo e o limite inferior como estimativa; `ambiguous` diz que não é único.
 * Preço que nenhuma margem reproduz (editado à mão) → marginPct null.
 * @param {(marginPct: number) => number|null} priceAt preço da regra para uma margem (null se erro)
 * @param {number} livePrice
 * @returns {{ marginPct: number|null, range: [number, number]|null, ambiguous: boolean }}
 */
export function inferMarginPct(priceAt, livePrice) {
  const matches = [];
  for (let m = 5; m <= 100; m += 1) {
    const p = priceAt(m);
    if (p != null && cents(p) === cents(livePrice)) matches.push(m);
  }
  if (!matches.length) return { marginPct: null, range: null, ambiguous: false };
  return { marginPct: matches[0], range: [matches[0], matches[matches.length - 1]], ambiguous: matches.length > 1 };
}
