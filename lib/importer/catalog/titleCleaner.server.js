/**
 * titleCleaner — limpeza sintática do título de catálogo (BRIEFING BACKEND, Tarefa 10;
 * regras 5-6 acrescentadas na Tarefa 10b / Decisão 8, portão dirigido).
 * Corre DEPOIS do franchiseResolver (precisa de `resolvedFranchise`/`resolvedLine`).
 * Função pura, sem I/O, sem tradução — só remove ruído do próprio texto:
 *
 *   1. prefixos de formato/locale do fornecedor (stripFormatPrefix do resolver)
 *   2. marca contraditória no início (universo diferente do resolvido, camada 2 pura)
 *   3. preço/moeda + unidade embutidos no título ("12,99€", "3.50€ x unit")
 *   4. segmento " - X" redundante quando X repete a cauda do que vem antes
 *   5. franquia/line resolvida repetida (mantém a 1.ª ocorrência de cada alias)
 *   6. normalização de espaços/pontuação órfã nas pontas
 *
 * NÃO decide franquia, NÃO traduz. `originalTitle` fica sempre preservado à parte —
 * este módulo só devolve o texto candidato a `cleanTitle`.
 *
 * Ref: BRIEFING — BACKEND, Tarefa 10 (2026-09-11) · Decisão 8 (portão dirigido, 5 casos
 * obrigatórios: Latino Pokemon…, Transformers Star Wars…, Grogu - The Mandalorian…,
 * Batman offer pack 3.50€ x unit, Rides Deluxe … Mandalorian … the Mandalorian…).
 */
import { stripFormatPrefix } from "./franchiseResolver.server.js";
import { FRANCHISE_UNIVERSES } from "./franchiseUniverses.js";
import { FRANCHISE_LINES } from "./franchiseLines.js";

/** "12,99€", "€ 12.99", "$19.99", com "x unit"/"per unit" opcional a seguir (Decisão 8,
 *  caso "Batman offer pack 3.50€ x unit"). */
const PRICE_RE = /(?:€\s?\d+(?:[.,]\d+)?|\$\s?\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s?€)(?:\s*x\s*unit|\s*per\s*unit)?/gi;

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Universo cujo titlePattern bate no INÍCIO do título mas é diferente do resolvido —
 *  sinal de marca contraditória (Tarefa 11). Devolve o título sem esse prefixo, ou o
 *  título tal como veio se não houver contradição. Só mexe na 1.ª palavra/frase — nunca
 *  remove um universo que apareça a meio (pode ser crossover legítimo). */
function stripContradictingLeadingBrand(title, resolvedFranchise) {
  if (!resolvedFranchise) return title;
  for (const u of FRANCHISE_UNIVERSES) {
    if (u.name === resolvedFranchise) continue;
    for (const pattern of u.titlePatterns) {
      const re = new RegExp(`^${escapeRegExp(pattern)}\\b\\s*`, "i");
      if (re.test(title)) return title.replace(re, "");
    }
  }
  return title;
}

/** "A - B" onde B começa por repetir a cauda de A (Decisão 8, caso "Star Wars The
 *  Mandalorian & Grogu - The Mandalorian & Grogu Deluxe figure…"). Testa sufixos de A
 *  do mais longo ao mais curto; ao encontrar sobreposição, remove só a parte repetida
 *  de B, preservando o resto (" Deluxe figure 9,5cm"). Não mexe se não houver overlap —
 *  dashes com conteúdo genuinamente distinto ("Batman - Robin") ficam intactos. */
function collapseDashRepeat(title) {
  const m = title.match(/^(.*?)\s[-–—]\s(.*)$/s);
  if (!m) return title;
  const [, before, after] = m;
  const beforeWords = before.split(/\s+/).filter(Boolean);
  const afterNorm = after.toLowerCase();
  for (let take = beforeWords.length; take >= 1; take--) {
    const suffix = beforeWords.slice(-take).join(" ");
    const suffixNorm = suffix.toLowerCase();
    if (!afterNorm.startsWith(suffixNorm)) continue;
    const nextChar = after[suffix.length];
    if (nextChar && !/[\s,.;:]/.test(nextChar)) continue; // não cortar a meio de uma palavra
    const remainder = after.slice(suffix.length).trim();
    return remainder ? `${before} ${remainder}` : before;
  }
  return title;
}

/** Mantém só a 1.ª ocorrência (palavra inteira, case-insensitive) de CADA alias na
 *  lista — cada alias é testado à parte, nunca trocado por outro (evita apagar "Grogu"
 *  por já ter visto "Mandalorian"). Consome um "the "/"The " imediatamente antes do
 *  alias quando remove uma repetição, para não deixar artigo pendurado. */
function collapseRepeatedAliases(title, aliases) {
  let t = title;
  for (const alias of aliases) {
    if (!alias) continue;
    const re = new RegExp(`(?:\\bthe\\s+)?\\b${escapeRegExp(alias)}\\b`, "gi");
    let seen = false;
    t = t.replace(re, (match) => {
      if (seen) return "";
      seen = true;
      return match;
    });
  }
  return t;
}

function normalizeSpacing(title) {
  return title
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/^[-–—,.\s]+|[-–—,.\s]+$/g, "")
    .trim();
}

/**
 * @param {{ title?: string, resolvedFranchise?: string|null, resolvedLine?: string|null }} product
 * @returns {{ result: string, firedRules: string[] }} — firedRules regista, por ordem,
 *  cada regra que efetivamente mudou o texto (para o dry-run dirigido, Tarefa 10b).
 */
export function cleanProductTitleWithTrace(product = {}) {
  const firedRules = [];
  let t = String(product.title || "");

  let next = stripFormatPrefix(t);
  if (next !== t) firedRules.push("prefixo-formato");
  t = next;

  next = stripContradictingLeadingBrand(t, product.resolvedFranchise);
  if (next !== t) firedRules.push("marca-contraditoria");
  t = next;

  next = t.replace(PRICE_RE, " ");
  if (next !== t) firedRules.push("preco-unidade");
  t = next;

  next = collapseDashRepeat(t);
  if (next !== t) firedRules.push("dash-repetido");
  t = next;

  const franchiseAliases = product.resolvedFranchise
    ? [product.resolvedFranchise, ...(FRANCHISE_UNIVERSES.find((u) => u.name === product.resolvedFranchise)?.titlePatterns || [])]
    : [];
  const line = product.resolvedLine ? FRANCHISE_LINES.find((l) => l.line === product.resolvedLine) : null;
  const lineAliases = line ? [line.line, ...(line.titlePatterns || [])] : [];
  next = collapseRepeatedAliases(t, [...new Set([...franchiseAliases, ...lineAliases])]);
  if (next !== t) firedRules.push("alias-repetido");
  t = next;

  next = normalizeSpacing(t);
  if (next !== t) firedRules.push("espacos");
  t = next;

  return { result: t, firedRules };
}

/**
 * @param {{ title?: string, resolvedFranchise?: string|null, resolvedLine?: string|null }} product
 * @returns {string} título candidato a `cleanTitle` — pode ser igual ao original.
 */
export function cleanProductTitle(product = {}) {
  return cleanProductTitleWithTrace(product).result;
}
