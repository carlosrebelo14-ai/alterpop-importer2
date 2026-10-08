/**
 * Preço de venda — briefing "Preço com margem e teto de mercado" (07/10/2026), que
 * substitui o de "margem e arredondamento" do mesmo dia (base era o PVPR — errado).
 *
 *   preço = margem sobre o custo, arredondada para cima
 *           nunca abaixo de PVPR_FLOOR_PCT do PVPR (revisão do dry-run, 07/10/2026)
 *           nunca acima do PVPR
 *           nunca abaixo do custo + MIN_MARGIN (este ganha a todos)
 *
 * O ÚNICO caminho de preço da app: painel (curadoria, staging, export) e publishers
 * importam daqui.
 *
 * - Custo: round(precio_distribuidores × 1,21) — CatalogProduct.distributorPrice com o
 *   IVA espanhol que o carrinho OcioStock cobra (confirmado: 9,99 → 12,09).
 * - PVPR: precio_bruto (CatalogProduct.grossPrice), já com IVA — teto, nunca custo.
 * - Margem: global (settings.priceMarginPct), sobre o custo, 5 a 100 %, inicial 40 %.
 * - Finais: ,50 e ,90 abaixo de 100 €, só ,90 a partir de 100 €. Margem arredonda para
 *   cima (roundUp); o teto arredonda para baixo (roundDown), para nunca passar o PVPR.
 * - Contas em cêntimos inteiros. IVA da venda fica fora (decisão do briefing).
 *
 * Estado de cada preço (selos no painel — avisam, nunca bloqueiam):
 *   MARGEM      margem pedida cabe entre o piso do PVPR e o PVPR
 *   PISO_PVPR   margem pedida ficava abaixo de 80 % do PVPR (custo anormalmente baixo,
 *               quase sempre oferta temporária do fornecedor) — preço = 80 % do PVPR
 *   TETO        margem pedida passava o PVPR — preço = PVPR arredondado para baixo
 *   ACIMA_PVPR  nem a margem mínima cabe abaixo do PVPR — preço = custo + MIN_MARGIN
 *   SEM_PVPR    feed sem precio_bruto — margem pedida, sem teto nem piso do PVPR
 *
 * Nada falha em silêncio: sem precio_distribuidores lança PricingError. Quem precisa de
 * mostrar o erro numa linha (painel) usa tryPriceProduct, que o devolve em vez de lançar.
 *
 * Testado em scripts/tests/pricing.test.js.
 */

export const DEFAULT_MARGIN_PCT = 40;
export const MIN_MARGIN_PCT = 5;
export const MAX_MARGIN_PCT = 100;
/** Piso: o preço nunca fica abaixo do custo + 10 %, mesmo que isso passe o PVPR. */
export const MIN_MARGIN = 10;
/**
 * Piso do PVPR: o preço nunca fica abaixo de 80 % do PVPR (arredondado para cima), nem
 * que a margem pedida dê menos. Custo normal anda entre 57 % e 76 % do PVPR; abaixo
 * disso é quase sempre oferta temporária do fornecedor, e o preço publicado não volta a
 * subir sozinho quando a oferta acaba. Nunca passa o teto (o PVPR arredondado para baixo).
 */
export const PVPR_FLOOR_PCT = 80;
/** IVA espanhol cobrado pela OcioStock sobre precio_distribuidores, em %. */
export const SUPPLIER_VAT_PCT = 21;

export const PRICE_STATUS = Object.freeze({
  MARGEM: "MARGEM",
  PISO_PVPR: "PISO_PVPR",
  TETO: "TETO",
  ACIMA_PVPR: "ACIMA_PVPR",
  SEM_PVPR: "SEM_PVPR",
});

export class PricingError extends Error {
  constructor(message) {
    super(message);
    this.name = "PricingError";
  }
}

function assertCents(c, fn) {
  if (!Number.isInteger(c) || c < 0) throw new PricingError(`${fn}: cêntimos inválidos (${c})`);
}

/**
 * Arredonda para cima até ao próximo final permitido.
 * @param {number} c cêntimos (inteiro ≥ 0)
 * @returns {number} cêntimos
 */
export function roundUp(c) {
  assertCents(c, "roundUp");
  const e = Math.floor(c / 100) * 100;
  const r = c % 100;
  let p = r <= 50 ? e + 50 : r <= 90 ? e + 90 : e + 150;
  if (p >= 10000) p = r <= 90 ? e + 90 : e + 190;
  return p;
}

/**
 * Arredonda para baixo até ao final permitido anterior (teto do PVPR).
 * @param {number} c cêntimos (inteiro ≥ 0)
 * @returns {number} cêntimos (pode ser negativo para c < 50 — o piso ganha sempre)
 */
export function roundDown(c) {
  assertCents(c, "roundDown");
  const e = Math.floor(c / 100) * 100;
  const r = c % 100;
  if (r >= 90) return e + 90;
  if (r >= 50 && e + 50 < 10000) return e + 50;
  return e - 10;
}

/**
 * @param {number} marginPct
 * @returns {number}
 */
export function assertMarginPct(marginPct) {
  const m = Number(marginPct);
  if (!Number.isFinite(m) || m < MIN_MARGIN_PCT || m > MAX_MARGIN_PCT) {
    throw new PricingError(`Margem inválida (${marginPct}) — tem de estar entre ${MIN_MARGIN_PCT} e ${MAX_MARGIN_PCT} %`);
  }
  // As contas usam pontos-base inteiros: mais de 2 casas decimais seria arredondado em
  // silêncio (40,001 % aplicaria 40,00 %). Recusa em vez de aplicar outra margem.
  if (Math.abs(m * 100 - Math.round(m * 100)) > 1e-9) {
    throw new PricingError(`Margem inválida (${marginPct}) — no máximo 2 casas decimais`);
  }
  return m;
}

/**
 * Custo com o IVA espanhol, em cêntimos inteiros (× 121 / 100 evita
 * 999 × 1.21 = 1208.7900000000002).
 * @param {number} distCents precio_distribuidores em cêntimos (inteiro > 0)
 */
export function costCentsFromDistributor(distCents) {
  if (!Number.isInteger(distCents) || distCents <= 0) {
    throw new PricingError(`precio_distribuidores inválido (${distCents} cêntimos)`);
  }
  return Math.round((distCents * (100 + SUPPLIER_VAT_PCT)) / 100);
}

/**
 * Margem que a regra aplica de facto: a gravada, mas nunca abaixo de MIN_MARGIN — o
 * piso do custo (custo + 10 %) ganha sempre, por isso 5 a 9 % dão o mesmo que 10 %.
 * O painel mostra este valor quando difere do gravado (revisão adversarial do PR #87).
 * @param {number} marginPct
 */
export function effectiveMarginPct(marginPct) {
  return Math.max(assertMarginPct(marginPct), MIN_MARGIN);
}

/**
 * @param {number} distCents precio_distribuidores em cêntimos (inteiro > 0), sem IVA
 * @param {number|null|undefined} pvprCents precio_bruto em cêntimos, ou vazio
 * @param {number} marginPct 5 a 100 (abaixo de MIN_MARGIN aplica MIN_MARGIN)
 * @returns {{ price: number, cost: number, status: keyof typeof PRICE_STATUS }} cêntimos
 */
export function finalPrice(distCents, pvprCents, marginPct) {
  const cost = costCentsFromDistributor(distCents);
  const m = effectiveMarginPct(marginPct);
  // Margem em pontos-base inteiros: cost × (10000 + bps) é um inteiro exato, por isso o
  // ceil nunca sobe um cêntimo por erro de vírgula flutuante numa margem decimal
  // (32,8 % sobre 31,25 dava 41,90 em vez de 41,50 — revisão adversarial do PR #87).
  const withM = (pct) => roundUp(Math.ceil((cost * (10000 + Math.round(pct * 100))) / 10000));
  const target = withM(m);
  const costFloor = withM(MIN_MARGIN);

  if (!pvprCents) return { price: Math.max(costFloor, target), cost, status: PRICE_STATUS.SEM_PVPR };
  if (!Number.isInteger(pvprCents) || pvprCents < 0) {
    throw new PricingError(`precio_bruto inválido (${pvprCents} cêntimos)`);
  }

  const cap = roundDown(pvprCents);
  // Piso do PVPR, nunca acima do teto. O piso do custo (custo + 10 %) ganha a ambos.
  const pvprFloor = Math.min(roundUp(Math.ceil((pvprCents * PVPR_FLOOR_PCT) / 100)), cap);
  const price = Math.max(costFloor, Math.min(Math.max(target, pvprFloor), cap));

  let status;
  if (costFloor > cap) status = PRICE_STATUS.ACIMA_PVPR;
  else if (target > cap) status = PRICE_STATUS.TETO;
  else if (pvprFloor > target && price === pvprFloor) status = PRICE_STATUS.PISO_PVPR;
  else status = PRICE_STATUS.MARGEM;
  return { price, cost, status };
}

/**
 * Margem global das definições da loja. Sem valor gravado → DEFAULT_MARGIN_PCT; valor
 * gravado fora do intervalo → lança (nunca cai em silêncio para o default). `null`
 * gravado de propósito (definições repostas depois de um ficheiro estragado) quer dizer
 * "por definir": lança até alguém aplicar a margem na Curadoria — nunca publica com uma
 * margem que ninguém escolheu.
 * @param {{ priceMarginPct?: number|string|null }} [settings]
 */
export function resolveMarginPct(settings) {
  const raw = settings?.priceMarginPct;
  if (raw === null) {
    throw new PricingError("Margem de preço por definir — aplica a margem global na Curadoria");
  }
  if (raw == null || raw === "") return DEFAULT_MARGIN_PCT;
  return assertMarginPct(raw);
}

/**
 * Regra de escrita de preço num produto que JÁ existe na Shopify (publisher e página
 * Import): só se escreve quando o preço live é 0 — nunca foi preço escolhido por
 * ninguém. Qualquer outro preço live fica: pode ser uma edição à mão no admin, e o
 * override da curadoria só se aplica na criação (revisão adversarial do PR #87).
 * Preço desconhecido (o chamador não o leu) lança: decidir às cegas podia deixar um
 * produto a 0,00 ou reescrever uma edição à mão.
 * @param {string|number|null|undefined} livePrice preço da variante na Shopify
 * @returns {boolean} true = escrever o preço calculado (ou o override)
 */
export function existingPriceNeedsWrite(livePrice) {
  if (livePrice === undefined || livePrice === null || livePrice === "") {
    throw new PricingError("Preço live da variante desconhecido — não é possível decidir se o preço pode ser escrito");
  }
  const n = Number(livePrice);
  if (!Number.isFinite(n)) throw new PricingError(`Preço live inválido (${livePrice})`);
  return !(n > 0);
}

/** euros (float do feed) → cêntimos inteiros, ou null se vazio/≤ 0 */
function toCents(euros) {
  const n = Number(euros);
  if (euros == null || euros === "" || !Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

/**
 * Preço de um produto a partir das colunas do catálogo (euros).
 * @param {number|null|undefined} distributorPrice precio_distribuidores, sem IVA
 * @param {number|null|undefined} grossPrice precio_bruto (PVPR com IVA)
 * @param {number} marginPct
 * @returns {{ finalPrice: number, cost: number, profit: number, pvpr: number|null,
 *   priceStatus: string, finalCents: number, costCents: number }}
 */
export function priceProduct(distributorPrice, grossPrice, marginPct) {
  const distCents = toCents(distributorPrice);
  if (distCents == null) {
    throw new PricingError("Sem precio_distribuidores (custo) — preço não calculado");
  }
  const pvprCents = toCents(grossPrice);
  const { price, cost, status } = finalPrice(distCents, pvprCents, marginPct);
  return {
    finalPrice: price / 100,
    cost: cost / 100,
    profit: (price - cost) / 100,
    pvpr: pvprCents != null ? pvprCents / 100 : null,
    priceStatus: status,
    finalCents: price,
    costCents: cost,
  };
}

/**
 * Igual a priceProduct, mas devolve o erro em vez de lançar — para mostrar por linha.
 * @param {number|null|undefined} distributorPrice
 * @param {number|null|undefined} grossPrice
 * @param {number} marginPct
 * @returns {{ finalPrice: number|null, cost: number|null, profit: number|null,
 *   pvpr: number|null, priceStatus: string|null, priceError: string|null }}
 */
export function tryPriceProduct(distributorPrice, grossPrice, marginPct) {
  try {
    const { finalPrice: price, cost, profit, pvpr, priceStatus } = priceProduct(distributorPrice, grossPrice, marginPct);
    return { finalPrice: price, cost, profit, pvpr, priceStatus, priceError: null };
  } catch (err) {
    return {
      finalPrice: null,
      cost: null,
      profit: null,
      pvpr: toCents(grossPrice) != null ? toCents(grossPrice) / 100 : null,
      priceStatus: null,
      priceError: err?.message || String(err),
    };
  }
}
