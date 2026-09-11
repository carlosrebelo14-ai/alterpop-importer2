/**
 * titleCleaner — limpeza sintática do título de catálogo (BRIEFING BACKEND, Tarefa 10).
 * Corre DEPOIS do franchiseResolver (precisa de `resolvedFranchise` para a regra 3).
 * Função pura, sem I/O, sem tradução — só remove ruído do próprio texto:
 *
 *   1. prefixos de formato do fornecedor (reaproveita stripFormatPrefix do resolver)
 *   2. preço/moeda embutidos no título ("12,99€", "$19.99")
 *   3. franquia resolvida repetida (mantém a 1.ª ocorrência, remove as seguintes)
 *   4. normalização de espaços/pontuação órfã nas pontas
 *
 * NÃO decide franquia, NÃO traduz. `originalTitle` fica sempre preservado à parte —
 * este módulo só devolve o texto candidato a `cleanTitle`.
 *
 * Ref: BRIEFING — BACKEND, Tarefa 10 (2026-09-11).
 */
import { stripFormatPrefix } from "./franchiseResolver.server.js";

/** "12,99€", "€ 12.99", "$19.99" — moeda + número, com ou sem espaço entre eles. */
const PRICE_RE = /(?:€\s?\d+(?:[.,]\d+)?|\$\s?\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s?€)/gi;

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Mantém só a 1.ª ocorrência (palavra inteira, case-insensitive) do nome da franquia. */
function collapseRepeatedFranchise(title, franchiseName) {
  if (!franchiseName) return title;
  const re = new RegExp(`\\b${escapeRegExp(franchiseName)}\\b`, "gi");
  let seen = false;
  return title.replace(re, (match) => {
    if (seen) return "";
    seen = true;
    return match;
  });
}

function normalizeSpacing(title) {
  return title
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/^[-–—,.\s]+|[-–—,.\s]+$/g, "")
    .trim();
}

/**
 * @param {{ title?: string, resolvedFranchise?: string|null }} product
 * @returns {string} título candidato a `cleanTitle` — pode ser igual ao original.
 */
export function cleanProductTitle(product = {}) {
  let t = String(product.title || "");
  t = stripFormatPrefix(t);
  t = t.replace(PRICE_RE, " ");
  t = collapseRepeatedFranchise(t, product.resolvedFranchise);
  t = normalizeSpacing(t);
  return t;
}
