/**
 * acceptedWarnings — ADENDA 8 (briefing backend, 17/09/2026).
 *
 * Avisos que o Carlos viu e aceitou explicitamente, SKU a SKU. Não entram na auditoria
 * (live-publish-audit.js) nem no V13 — o mesmo código noutro SKU continua a contar
 * normalmente, isto nunca desliga a verificação em geral.
 *
 * Lista fechada, editada em código — mesmo espírito de NOISE_PREFIXES/
 * MANUFACTURER_LINE_RULES: aceitar um caso novo é decisão do Carlos, registada aqui de
 * propósito, nunca inferida automaticamente.
 */
export const ACCEPTED_WARNINGS = [
  // Os dois Luke Skywalker (ADENDA 6/8, 17/09/2026) — SKUs 889698675369/889698837972,
  // duas versões diferentes da mesma figura, título idêntico no feed. Decisão do
  // Carlos de 17/09: os dois títulos ficam como estão, assunto fechado.
  { sku: "889698675369", code: "TITLE_DUPLICATE" },
  { sku: "889698837972", code: "TITLE_DUPLICATE" },
];

/**
 * @param {string} sku
 * @param {string} code
 */
export function isWarningAccepted(sku, code) {
  return ACCEPTED_WARNINGS.some((w) => w.sku === sku && w.code === code);
}
