/**
 * P1 (briefing 06/11/2026). O resumo do catalog_health publica `esperado` e `obtido` de cada verificação
 * vermelha ou amarela, só com números. O repositório é público: nada de SKUs, handles, tags nem GIDs.
 *
 * `numerosPublicaveis` aceita um texto de verificação e devolve só os números, ou null.
 *  1. Retira um vocabulário fechado de palavras de contagem ("produto(s)", "divergência(s)", "tag(s)", ...).
 *  2. O que sobra tem de ser só dígitos, operadores, %, pontuação e parênteses. Qualquer outra letra recusa o campo.
 *  3. Nenhuma sequência de dígitos passa de 7. SKUs, EAN e GTIN têm 8 ou mais dígitos.
 */

/** Palavras de contagem que as verificações usam ao lado dos números. Lista fechada, em minúsculas. */
export const PALAVRAS_DE_CONTAGEM = Object.freeze([
  "produto(s)",
  "divergência(s)",
  "corrigido(s)",
  "aprovado(s)",
  "novo(s)",
  "tag(s)",
  "distinta(s)",
  "com tags fora da lista",
  "produtos em drift",
  "do catálogo",
  "rácio",
  "total",
  "pp",
]);

/** Maior número de dígitos seguidos que se publica. */
export const MAX_DIGITOS_SEGUIDOS = 7;

/** @param {unknown} valor @returns {string | null} */
export function numerosPublicaveis(valor) {
  let texto = String(valor ?? "").toLowerCase();
  texto = texto.replace(/≤/g, "<=").replace(/≥/g, ">=");
  for (const palavra of PALAVRAS_DE_CONTAGEM) texto = texto.split(palavra).join(" ");
  texto = texto.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").replace(/ ,/g, ",").trim();
  if (!/[0-9]/.test(texto)) return null;
  if (!/^[0-9<>=.,;%/() -]+$/.test(texto)) return null;
  if (new RegExp(`[0-9]{${MAX_DIGITOS_SEGUIDOS + 1},}`).test(texto)) return null;
  return texto;
}

/**
 * Linha `NUMS:` de uma verificação não verde. Começa na coluna 0, para não contar como linha de verificação.
 * @param {{ id: string, level: string, expected: unknown, actual: unknown }} r
 * @returns {string | null}
 */
export function linhaNums(r) {
  if (r.level !== "fail" && r.level !== "warn") return null;
  const esperado = numerosPublicaveis(r.expected) ?? "n/d";
  const obtido = numerosPublicaveis(r.actual) ?? "n/d";
  return `NUMS: ${r.id} nivel=${r.level} esperado=${esperado} obtido=${obtido}`;
}
