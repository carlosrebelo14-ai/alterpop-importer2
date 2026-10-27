/**
 * characterResolver — resolve os Characters (B7) presentes num produto, a partir do
 * título e da franquia já resolvida. Função pura, sem I/O. `.server.js` só para ficar
 * fora do bundle de cliente.
 *
 * Entrada: `titleOverride ?? originalTitle` (o override do Carlos manda sobre o feed em
 * tudo o que vem a seguir — regra geral do arranque, secção 2) e `resolvedFranchise`.
 *
 * Passagem A — nome ou alias de CHARACTER_VOCABULARY, com fronteira de palavra, sem
 * distinguir maiúsculas, em NFC, só quando `resolvedFranchise` é o universo desse nome.
 * Um nome só conta dentro do universo esperado (ex.: "Robin" só conta em produtos
 * Batman) porque a procura nem olha para os nomes de outros universos.
 *
 * Passagem B (os 10 nomes de PASSAGEM_B_NAMES) fica fora deste trabalho — a passagem A
 * é a única aplicada aqui, para todos os nomes, incluindo esses 10.
 *
 * Epónimos — um nome de EPONYM_CANDIDATES nunca aparece no resultado, exceto se tiver
 * exceção registada em EPONYM_OVERRIDES (hoje só "Batman", decisão de 17/09/2026).
 *
 * Saída: lista de handles em NFC, na ordem em que os nomes aparecem no título, ou
 * `null` quando nenhum casa (campo Prisma `resolvedCharacters`, nullable).
 */
import { CHARACTER_VOCABULARY, CHARACTER_ALIASES, EPONYM_CANDIDATES, EPONYM_OVERRIDES } from "./characterVocabulary.js";

const nfc = (s) => (s == null ? s : String(s).normalize("NFC"));

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Forma canónica curta do handle (regra do arranque, secção 4): minúsculas, sem
 *  acentos/apóstrofos, espaços e pontuação viram um único hífen, sem hífens nas pontas. */
export function toHandle(nome) {
  return nfc(nome)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // remove diacríticos
    .replace(/['’]/g, "") // apóstrofo desaparece, não vira hífen
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const OVERRIDDEN_EPONYMS = new Set(EPONYM_OVERRIDES.map((o) => o.nome));
const BLOCKED_EPONYMS = new Set(EPONYM_CANDIDATES.filter((c) => !OVERRIDDEN_EPONYMS.has(c.nome)).map((c) => c.nome));

/**
 * @param {{ originalTitle?: string|null, titleOverride?: string|null, resolvedFranchise?: string|null }} input
 * @returns {string[]|null} handles, na ordem em que os nomes aparecem no título
 */
export function resolveCharacters({ originalTitle, titleOverride, resolvedFranchise }) {
  const title = nfc(titleOverride ?? originalTitle);
  if (!title || !resolvedFranchise) return null;

  const universo = CHARACTER_VOCABULARY.find((e) => e.universo === resolvedFranchise);
  if (!universo) return null;

  const candidatas = [];
  for (const nome of universo.nomes) {
    if (BLOCKED_EPONYMS.has(nome)) continue;

    for (const candidato of [nome, ...(CHARACTER_ALIASES[nome] || [])]) {
      const re = new RegExp(`\\b${escapeRegExp(nfc(candidato))}\\b`, "iu");
      const match = re.exec(title);
      if (match) candidatas.push({ nome, start: match.index, end: match.index + match[0].length });
    }
  }

  // Trecho consumido (decisão do arquiteto, 27/10/2026): o match mais longo fica com o seu
  // trecho do título; um nome contido nesse trecho deixa de contar. "Mouth of Sauron" dá só
  // mouth-of-sauron. "Frodo Baggins & Gollum" dá os dois, porque os trechos não se sobrepõem.
  candidatas.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const aceites = [];
  for (const c of candidatas) {
    if (aceites.some((a) => c.start < a.end && a.start < c.end)) continue;
    aceites.push(c);
  }

  const primeiraPosicao = new Map();
  for (const a of aceites) {
    if (!primeiraPosicao.has(a.nome) || a.start < primeiraPosicao.get(a.nome)) primeiraPosicao.set(a.nome, a.start);
  }
  if (primeiraPosicao.size === 0) return null;
  return [...primeiraPosicao.entries()].sort((x, y) => x[1] - y[1]).map(([nome]) => toHandle(nome));
}
