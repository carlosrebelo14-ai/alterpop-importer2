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
 * ATENÇÃO A QUEM VIER MUDAR AS REGRAS: o portão desta limpeza é o DEPLOY, não o
 * `--execute` do title-clean-dryrun.js. `cleanTitle` é calculado no ingest
 * (catalogProducts.server.js → toLiteProduct), e o catálogo reindexa sozinho de ciclo a
 * ciclo — por isso mudar uma regra aqui e deployar aplica-a a todo o catálogo no ciclo
 * seguinte, sem ninguém correr backfill nenhum. O `--execute` é retroativo sobre
 * trabalho que o ingest já faz e hoje é quase um no-op. Medir ANTES de deployar:
 *   npm run title:prefix-restore-dryrun
 * Na loja não muda nada até alguém republicar: o publisher só escreve título na via
 * APPROVED, e o publishedStockSync nunca toca em título, de propósito.
 *
 * Ref: BRIEFING — BACKEND, Tarefa 10 (2026-09-11) · Decisão 8 (portão dirigido, 5 casos
 * obrigatórios: Latino Pokemon…, Transformers Star Wars…, Grogu - The Mandalorian…,
 * Batman offer pack 3.50€ x unit, Rides Deluxe … Mandalorian … the Mandalorian…).
 */
import { stripFormatPrefix, NOISE_PREFIXES } from "./franchiseResolver.server.js";
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
 *  dashes com conteúdo genuinamente distinto ("Batman - Robin") ficam intactos.
 *
 *  Tarefa 20 (aperto, 2026-09-11): overlap de 1 palavra só só colapsa se essa palavra
 *  for um alias conhecido da franquia/line resolvida (ex.: "Gundam" repetido em
 *  "Mobile Suit Gundam - Gundam Ashtaron…" — o produto É Gundam). Sem essa condição,
 *  "Ferrari Power Racing - Racing circuit" colapsava sobre "Racing", uma palavra
 *  genérica sem ligação a franquia nenhuma — falso positivo visto na amostra de 2000
 *  da Tarefa 10b. Overlaps de 2+ palavras continuam sem essa restrição (risco de
 *  coincidência muito mais baixo). */
function collapseDashRepeat(title, aliasesLower) {
  const m = title.match(/^(.*?)\s[-–—]\s(.*)$/s);
  if (!m) return title;
  const [, before, after] = m;
  const beforeWords = before.split(/\s+/).filter(Boolean);
  const afterNorm = after.toLowerCase();
  for (let take = beforeWords.length; take >= 1; take--) {
    const suffix = beforeWords.slice(-take).join(" ");
    const suffixNorm = suffix.toLowerCase();
    if (!afterNorm.startsWith(suffixNorm)) continue;
    if (take === 1 && !aliasesLower.has(suffixNorm)) continue;
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

/** Travão 1 — quantas vezes o strip de prefixo pode correr sobre o mesmo título. */
const MAX_PASSAGENS_PREFIXO = 3;

/** Travão 2 — o que pode sobrar depois de uma passagem. Nunca vazio; uma palavra isolada
 *  só sobra se for alias conhecido da franquia/line resolvida ("Batman" sim, "figure"
 *  não). Lição da Tarefa 19/20, onde colapsar sobre uma palavra genérica deu falso
 *  positivo real. */
function sobraSuficiente(texto, aliasesLower) {
  const t = String(texto || "").trim();
  if (!t) return false;
  const palavras = t.split(/\s+/).filter(Boolean);
  if (palavras.length >= 2) return true;
  return aliasesLower.has(palavras[0].toLowerCase());
}

function normalizeSpacing(title) {
  return title
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/^[-–—,.\s]+|[-–—,.\s]+$/g, "")
    .trim();
}

/**
 * @param {{ title?: string, resolvedFranchise?: string|null, resolvedLine?: string|null,
 *           resolvedFormat?: string|null }} product
 *  `resolvedFormat` é a guarda do averbamento à Decisão 17 — sem ele, um prefixo de
 *  FORMATO fica no título (e a regra reporta-se como "prefixo-formato-travado").
 * @returns {{ result: string, firedRules: string[] }} — firedRules regista, por ordem,
 *  cada regra que efetivamente mudou o texto (para o dry-run dirigido, Tarefa 10b).
 */
export function cleanProductTitleWithTrace(product = {}) {
  const firedRules = [];
  let t = String(product.title || "");

  // Aliases da franquia/line resolvida — calculados AQUI em cima (e não a meio, como
  // antes) porque o travão do mínimo precisa deles: uma palavra isolada só pode sobrar
  // se for um alias conhecido.
  const franchiseAliasesTop = product.resolvedFranchise
    ? [product.resolvedFranchise, ...(FRANCHISE_UNIVERSES.find((u) => u.name === product.resolvedFranchise)?.titlePatterns || [])]
    : [];
  const lineTop = product.resolvedLine ? FRANCHISE_LINES.find((l) => l.line === product.resolvedLine) : null;
  const lineAliasesTop = lineTop ? [lineTop.line, ...(lineTop.titlePatterns || [])] : [];
  const aliases = [...new Set([...franchiseAliasesTop, ...lineAliasesTop])];
  const aliasesLower = new Set(aliases.map((a) => a.toLowerCase()));

  // GUARDA (averbamento à Decisão 17, 2026-09-14) — o prefixo de formato só sai quando
  // `resolvedFormat` está preenchido para este produto, porque é aí que a informação
  // passa a viver (alterpop.format). Sem formato resolvido, remover o prefixo não muda
  // a informação de sítio: destrói-a. Esses produtos ficam com o título como está e
  // contam-se à parte no relatório.
  //
  // Na prática encaixa: o extractProductFormat tira o formato do próprio prefixo
  // ("POP figure" → Figure, "Pocket POP Keychain" → Keychain), por isso quem tem prefixo
  // informativo tem quase sempre formato. A guarda apanha o resto.
  // `Assorted`/`Latino` saem sempre: a Decisão 17 classificou-os como ruído sem
  // informação nenhuma, logo não há nada para a guarda proteger.
  //
  // ITERA (2026-09-14) — os prefixos empilham-se no feed ("Assorted Blister 4 figures
  // Bitty POP Demon Slayer"), e tirar só o primeiro deixava a mesma duplicação que esta
  // decisão existe para eliminar, com um passo a menos. Três travões:
  //   1. no máximo MAX_PASSAGENS_PREFIXO passagens — mais do que isso é título anómalo,
  //      não empilhamento, e não se adivinha;
  //   2. nunca colapsar para vazio nem para uma palavra genérica isolada (lição da
  //      Tarefa 19/20: "Racing" sozinho não é sinal de nada);
  //   3. a guarda de formato aplica-se A CADA passagem, com o mesmo vocabulário e as
  //      mesmas exceções — não se avalia uma vez e liberta o resto.
  let passagens = 0;
  let travadoPelaGuarda = false;
  let travaoMinimo = false;
  while (passagens < MAX_PASSAGENS_PREFIXO) {
    const listaAplicavel = product.resolvedFormat ? undefined : NOISE_PREFIXES;
    const candidato = listaAplicavel ? stripFormatPrefix(t, listaAplicavel) : stripFormatPrefix(t);
    if (candidato === t) {
      // Nada saiu nesta passagem. Se havia prefixo de FORMATO e não há onde o guardar,
      // foi a guarda — regista-se para o relatório o poder contar à parte.
      if (!product.resolvedFormat && stripFormatPrefix(t) !== t) travadoPelaGuarda = true;
      break;
    }
    if (!sobraSuficiente(candidato, aliasesLower)) {
      travaoMinimo = true; // travão 2 — o que sobrava não chegava
      break;
    }
    t = candidato;
    passagens += 1;
  }
  if (passagens > 0) firedRules.push("prefixo-formato");
  if (travadoPelaGuarda) firedRules.push("prefixo-formato-travado");

  let next = t;

  next = stripContradictingLeadingBrand(t, product.resolvedFranchise);
  if (next !== t) firedRules.push("marca-contraditoria");
  t = next;

  next = t.replace(PRICE_RE, " ");
  if (next !== t) firedRules.push("preco-unidade");
  t = next;

  next = collapseDashRepeat(t, aliasesLower);
  if (next !== t) firedRules.push("dash-repetido");
  t = next;

  next = collapseRepeatedAliases(t, aliases);
  if (next !== t) firedRules.push("alias-repetido");
  t = next;

  next = normalizeSpacing(t);
  if (next !== t) firedRules.push("espacos");
  t = next;

  return { result: t, firedRules, prefixoPassagens: passagens, prefixoTravaoMinimo: travaoMinimo };
}

/**
 * @param {{ title?: string, resolvedFranchise?: string|null, resolvedLine?: string|null,
 *           resolvedFormat?: string|null }} product
 *  `resolvedFormat` é a guarda do averbamento à Decisão 17 — sem ele, um prefixo de
 *  FORMATO fica no título (e a regra reporta-se como "prefixo-formato-travado").
 * @returns {string} título candidato a `cleanTitle` — pode ser igual ao original.
 */
export function cleanProductTitle(product = {}) {
  return cleanProductTitleWithTrace(product).result;
}
