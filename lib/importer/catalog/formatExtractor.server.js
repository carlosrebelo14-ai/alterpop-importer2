/**
 * formatExtractor — BRIEFING BACKEND, Tarefa 34 (Decisão 18).
 *
 * Deriva um "formato" normalizado do produto (Figure, Keychain, Backpack, Plush,
 * Puzzle, Mug, Blind Box) a partir do título — o MESMO vocabulário que saiu de
 * FORMAT_PREFIXES na Tarefa 32 (Decisão 17): era ruído a limpar do título, mas é sinal
 * genuíno de formato de produto. Fecha o círculo — a informação não se perde, passa a
 * viver num metafield estruturado (alterpop.format, Tarefa 35) em vez de inline no
 * título.
 *
 * Função pura, sem I/O. Vocabulário fechado, ordenado por especificidade (frase mais
 * longa primeiro dentro de cada formato). Um produto só leva UM formato — a primeira
 * categoria que bater, na ordem da tabela.
 */
import { isKnownFigureOnlyManufacturerLine } from "./manufacturerLineExtractor.server.js";

const FORMAT_CATEGORIES = [
  { format: "Keychain", needles: ["pocket pop keychain", "keychain", "llavero"] },
  {
    format: "Figure",
    needles: [
      "blister 4 figures bitty pop",
      "blister 3 figures bitty pop",
      "blister 2 figures bitty pop",
      "blister figures bitty pop",
      "display bitty pop",
      "pop super figure",
      "figure pop",
      "pop figure",
      "figura",
      "figure",
    ],
  },
  { format: "Backpack", needles: ["backpack", "loungefly", "mochila"] },
  { format: "Plush", needles: ["plush toy", "plush", "peluche"] },
  // D2 (ADENDA 4, 17/09/2026) — caso real: "Disney Frozen Tea set Elsa doll 38cm"
  // (SKU 0192995218383, R3 na auditoria de 17/09). "muñeca" cobre o mesmo termo do
  // fornecedor em espanhol que "peluche"/"llavero" já cobrem para Plush/Keychain.
  { format: "Doll", needles: ["doll", "muñeca", "muneca"] },
  { format: "Puzzle", needles: ["puzzle"] },
  { format: "Mug", needles: ["mug", "taza"] },
  { format: "Blind Box", needles: ["blind box", "mystery", "surprise"] },
];

/**
 * D2 (ADENDA 4, 17/09/2026) — "todas as categorias de formato são em inglês". Lista
 * aprovada dos VALORES de formato (não das needles — essas ficam livres para bater
 * texto do fornecedor em qualquer língua). Um teste falha se `FORMAT_VALUES` tiver
 * algo fora desta lista, para não deixar entrar um valor não-inglês sem decisão.
 */
export const APPROVED_FORMAT_VALUES = [
  "Keychain",
  "Figure",
  "Backpack",
  "Plush",
  "Doll",
  "Puzzle",
  "Mug",
  "Blind Box",
];

function normText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * R1 (auditoria live, 17/09/2026): o fornecedor escreve tanto singular como plural
 * ("2 figures", não só "figure") — a needle tem de bater nos dois sem duplicar a
 * tabela à mão. Plural regular (+s) chega para o vocabulário atual.
 * @param {string} needle
 */
function needleVariants(needle) {
  return needle.endsWith("s") ? [needle] : [needle, `${needle}s`];
}

/**
 * @param {{ title?: string, vendor?: string|null }} product
 * @returns {string|null} um dos formatos fechados, ou null se nenhum bater.
 */
export function extractProductFormat(product = {}) {
  const haystack = ` ${normText(product.title)} `;
  for (const cat of FORMAT_CATEGORIES) {
    for (const needle of cat.needles) {
      for (const variant of needleVariants(needle)) {
        if (haystack.includes(` ${variant} `)) return cat.format;
      }
    }
  }
  // R2 (auditoria live, 17/09/2026): título não dá formato, mas a manufacturer_line
  // resolvida é uma linha confirmada como só-figuras (ver manufacturerLineExtractor).
  if (isKnownFigureOnlyManufacturerLine(product)) return "Figure";
  return null;
}

/** Lista dos formatos possíveis, na ordem de prioridade — para relatórios/testes. */
export const FORMAT_VALUES = FORMAT_CATEGORIES.map((c) => c.format);
