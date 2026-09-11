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
  { format: "Puzzle", needles: ["puzzle"] },
  { format: "Mug", needles: ["mug", "taza"] },
  { format: "Blind Box", needles: ["blind box", "mystery", "surprise"] },
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
 * @param {{ title?: string }} product
 * @returns {string|null} um dos formatos fechados, ou null se nenhum bater.
 */
export function extractProductFormat(product = {}) {
  const haystack = ` ${normText(product.title)} `;
  for (const cat of FORMAT_CATEGORIES) {
    for (const needle of cat.needles) {
      if (haystack.includes(` ${needle} `)) return cat.format;
    }
  }
  return null;
}

/** Lista dos formatos possíveis, na ordem de prioridade — para relatórios/testes. */
export const FORMAT_VALUES = FORMAT_CATEGORIES.map((c) => c.format);
