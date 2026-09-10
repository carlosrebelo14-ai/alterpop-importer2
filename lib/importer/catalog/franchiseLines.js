/**
 * Tabela de Lines — sub-divisões DENTRO de um universo (parent), não universos autónomos.
 *
 * Decisão de negócio (ENTREGA 2, 2026-09-10): The Mandalorian deixa de ser universo e
 * passa a Line dentro de Star Wars. O produto continua a resolver `franchise = "Star Wars"`
 * (entra na sala Star Wars) e ganha `line = "The Mandalorian"` (entra também na sala da
 * Line). O parent GANHA SEMPRE o slot de franquia — a Line é classificação adicional.
 *
 * Consumido por:
 * - franchiseResolver.server.js — deteta a Line por ref/título e força `franchise = parent`
 * - franchiseConditions.js       — a `condition` entra na lista versionada handle+condition
 * - metafield alterpop.line (list.single_line_text_field) + coleção com templateSuffix "line"
 *
 * Campos:
 * - line          nome canónico (valor de alterpop.line, título da coleção Line)
 * - parent        nome canónico do universo pai (TEM de existir em FRANCHISE_UNIVERSES)
 * - handle        handle da coleção Shopify (imutável depois de indexado)
 * - condition     valor exato usado na regra `alterpop.line EQUALS <condition>` da coleção
 *                 (== line; explícito para a lista versionada e o diff)
 * - refs          valores esperados nos ref="..." do feed (mesma máquina da camada 1)
 * - titlePatterns padrões no título (mesma máquina da camada 2, ancorados por palavra)
 *
 * ⚠️ Regressão a evitar: os refs/titlePatterns aqui têm de cobrir EXATAMENTE o que a
 * antiga entrada "The Mandalorian" de franchiseUniverses.js cobria (refs ["Mandalorian"],
 * titlePatterns ["Mandalorian","Grogu","Ahsoka"]). Tirar sem repor destrói a Line em 291
 * registos.
 */

/** @typedef {{ line: string, parent: string, handle: string, condition: string, refs: string[], titlePatterns: string[] }} FranchiseLine */

/** @type {FranchiseLine[]} */
export const FRANCHISE_LINES = [
  {
    line: "The Mandalorian",
    parent: "Star Wars",
    handle: "the-mandalorian",
    condition: "The Mandalorian",
    refs: ["Mandalorian"],
    titlePatterns: ["Mandalorian", "Grogu", "Ahsoka"],
  },
];

/** templateSuffix aplicado à coleção Line via CollectionInput. */
export const LINE_TEMPLATE_SUFFIX = "line";

/** @param {string} handle */
export function getLineByHandle(handle) {
  return FRANCHISE_LINES.find((l) => l.handle === handle) || null;
}

/** @param {string} name */
export function getLineByName(name) {
  const n = String(name || "").trim().toLowerCase();
  return FRANCHISE_LINES.find((l) => l.line.toLowerCase() === n) || null;
}
