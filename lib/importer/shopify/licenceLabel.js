/**
 * Normalização partilhada da licença/franchise — item 5 (coleções automáticas).
 *
 * Bug de code review (2026-08-13): o valor gravado no metafield ociostock.licence
 * (shopifyProductPublisher.server.js) era o texto em bruto do feed, e a regra da
 * smart collection (autoCollections.server.js) usa EQUALS — comparação exata,
 * sensível a maiúsculas/minúsculas. O feed OcioStock não é consistente na
 * capitalização da mesma licença entre linhas (ex.: "Star Wars" vs "star wars"),
 * por isso a coleção contava produtos por uma chave normalizada mas a regra só
 * apanhava a variante de casing do primeiro produto encontrado — ficava com menos
 * produtos do que os contados.
 *
 * Fix: normalizar para a MESMA forma canónica (Title Case) tanto no valor escrito
 * no metafield de cada produto como na condição da regra da coleção, para que
 * batam sempre certo independentemente do casing de origem no CSV.
 */

/** @param {string|null|undefined} raw */
export function normalizeLicenceLabel(raw) {
  const trimmed = String(raw || "").trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  return trimmed
    .toLowerCase()
    .replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}
