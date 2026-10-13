/**
 * Regra de preço em vigor — briefing "Preço sem IVA e guarda do tema" (Decisão 31).
 *
 *   LEGACY  custo × 1,21, finais ,50/,90, piso 80 % do PVPR e teto do PVPR (preço com IVA)
 *   NET     custo sem IVA, margem, arredondado para cima à dezena de cêntimos (preço sem IVA;
 *           todo o IVA fica na Shopify)
 *
 * A flag PRICE_MODE=NET liga a regra NET para a app inteira (publisher, painel, reprice).
 * Desligada por omissão: só liga depois de o Carlos confirmar a configuração de impostos
 * na Shopify (a loja tem taxesIncluded = true).
 *
 * Lida em tempo de chamada, nunca no import: os testes alternam o modo e o módulo de preço
 * não importa config.js/dotenv. Quem precisa de calcular numa regra sem mudar a global (a
 * pré-visualização de "Aplicar aos publicados" com rule=NET) passa a regra explícita a
 * resolvePriceRule / evaluatePrice.
 */

export const PRICE_RULE = Object.freeze({ NET: "NET", LEGACY: "LEGACY" });

/**
 * Regra global do servidor. Vazio ou LEGACY → LEGACY; NET → NET. Qualquer outro valor lança:
 * um erro de escrita em PRICE_MODE não pode deixar a app em silêncio na regra errada.
 * @returns {"NET"|"LEGACY"}
 */
export function currentPriceRule() {
  const raw = String(process.env.PRICE_MODE ?? "").trim().toUpperCase();
  if (raw === "" || raw === PRICE_RULE.LEGACY) return PRICE_RULE.LEGACY;
  if (raw === PRICE_RULE.NET) return PRICE_RULE.NET;
  throw new Error(`PRICE_MODE inválido (${process.env.PRICE_MODE}) — usa NET ou deixa vazio`);
}

export function isNetMode() {
  return currentPriceRule() === PRICE_RULE.NET;
}

/**
 * Regra pedida ou, sem ela, a global. Valor desconhecido lança.
 * @param {string|null|undefined} rule
 * @returns {"NET"|"LEGACY"}
 */
export function resolvePriceRule(rule) {
  if (rule == null || rule === "") return currentPriceRule();
  if (rule === PRICE_RULE.NET || rule === PRICE_RULE.LEGACY) return rule;
  throw new Error(`Regra de preço inválida (${rule}) — usa NET ou LEGACY`);
}

/**
 * Regra de um registo guardado (lastPriceWrite, histórico). Registos anteriores à
 * Decisão 31 não têm campo e são LEGACY.
 * @param {{ rule?: string|null }|null|undefined} record
 * @returns {"NET"|"LEGACY"}
 */
export function ruleOfRecord(record) {
  return record?.rule === PRICE_RULE.NET ? PRICE_RULE.NET : PRICE_RULE.LEGACY;
}
