/**
 * Lista versionada de condições de coleção — fonte ÚNICA da verdade para as regras
 * `<metafield> EQUALS <condition>` das salas Universe e Line (ENTREGA 2 §4).
 *
 * Derivada de franchiseUniverses.js (39 universos) + franchiseLines.js (1 Line). O
 * objetivo é ter um artefacto no repo contra o qual o `franchise-conditions-diff.js`
 * compara as regras REAIS da Shopify — por CODE POINT, não por render — antes de
 * qualquer escrita de metafields. Sem isto, um "Pokémon" em NFD na regra da coleção e
 * em NFC no metafield nunca casam e a sala fica vazia sem erro.
 *
 * Todas as condições são forçadas a NFC aqui (mesma normalização do resolver e do
 * publisher). assertConditionsNFC() falha o arranque se algum `name`/`line` das tabelas
 * vier decomposto.
 *
 * Armadilhas conhecidas (têm de sobreviver ao round-trip byte a byte):
 *   Pokémon           é = U+00E9 (NFC), nunca e + U+0301
 *   Spy × Family      × = U+00D7 (sinal de multiplicação), nunca a letra x
 *   Mickey & Friends  & literal (o transporte é que às vezes mete &amp;)
 *   G.I. Joe          espaços normais U+0020, nunca U+00A0
 */
import { FRANCHISE_UNIVERSES, UNIVERSE_TEMPLATE_SUFFIX } from "./franchiseUniverses.js";
import { FRANCHISE_LINES, LINE_TEMPLATE_SUFFIX } from "./franchiseLines.js";

const nfc = (s) => String(s == null ? "" : s).normalize("NFC");

/** @typedef {{ handle: string, condition: string, metafield: "alterpop.franchise" | "alterpop.line", templateSuffix: string, kind: "universe" | "line", active: boolean, dormant: boolean }} FranchiseCondition */

/** @type {FranchiseCondition[]} */
export const FRANCHISE_CONDITIONS = Object.freeze([
  ...FRANCHISE_UNIVERSES.map((u) => ({
    handle: u.handle,
    condition: nfc(u.name),
    metafield: /** @type {const} */ ("alterpop.franchise"),
    templateSuffix: UNIVERSE_TEMPLATE_SUFFIX,
    kind: /** @type {const} */ ("universe"),
    active: !!u.active,
    dormant: !!u.dormant,
  })),
  ...FRANCHISE_LINES.map((l) => ({
    handle: l.handle,
    condition: nfc(l.condition),
    metafield: /** @type {const} */ ("alterpop.line"),
    templateSuffix: LINE_TEMPLATE_SUFFIX,
    kind: /** @type {const} */ ("line"),
    active: true,
    dormant: false,
  })),
].map(Object.freeze));

/** Handles cobertos por esta lista (Universe + Line). */
export const FRANCHISE_CONDITION_HANDLES = new Set(FRANCHISE_CONDITIONS.map((c) => c.handle));

/** @param {string} handle */
export function getConditionByHandle(handle) {
  return FRANCHISE_CONDITIONS.find((c) => c.handle === handle) || null;
}

/**
 * Garante que todas as condições estão em NFC (nenhum name/line das tabelas veio
 * decomposto). Chamado no arranque do diff e nos testes. Devolve lista de problemas.
 * @returns {string[]}
 */
export function assertConditionsNFC() {
  const problems = [];
  for (const c of FRANCHISE_CONDITIONS) {
    if (c.condition !== c.condition.normalize("NFC")) {
      problems.push(`condição "${c.handle}" não está em NFC`);
    }
    if (new RegExp("[\\u00A0\\u2007\\u202F]").test(c.condition)) {
      problems.push(`condição "${c.handle}" tem espaço non-breaking`);
    }
  }
  // handles duplicados entre universe e line
  const seen = new Set();
  for (const c of FRANCHISE_CONDITIONS) {
    if (seen.has(c.handle)) problems.push(`handle duplicado na lista: "${c.handle}"`);
    seen.add(c.handle);
  }
  return problems;
}
