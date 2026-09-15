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
import { normalizeForMatch } from "../shopify/universeCollections.server.js";

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

/** Travão 2 — o que pode sobrar DENTRO do laço do prefixo, passagem a passagem. Nunca
 *  vazio; uma palavra isolada só sobra se for ela própria um alias conhecido ("Batman"
 *  sim, "figure" não — lição da Tarefa 19/20). Só protege contra destruir informação a
 *  meio do laço — não decide se o resultado FINAL do pipeline inteiro é aceitável, isso
 *  é o travão 3 (ver `aliasColideNoFinal`), porque regras que correm DEPOIS do laço
 *  (dash-repetido, alias-repetido) também podem colapsar para o nome da franquia, e o
 *  laço não tem como o ver a meio. */
function sobraSuficiente(texto, aliasesNorm) {
  const t = String(texto || "").trim();
  if (!t) return false;
  const palavras = t.split(/\s+/).filter(Boolean);
  if (palavras.length >= 2) return true;
  return aliasesNorm.has(normalizeForMatch(palavras[0]));
}

/** Travão 3 (briefing 15/09/2026 · B0, correção ao ponto de avaliação) — o `cleanTitle`
 *  FINAL, depois de TODAS as regras do pipeline correrem (não só o laço do prefixo),
 *  nunca pode ficar igual à string inteira de um alias da franquia/line. O laço do
 *  prefixo só vê o candidato logo a seguir a tirar o prefixo; uma regra posterior
 *  (dash-repetido, alias-repetido) pode continuar a colapsar depois disso — foi o caso
 *  medido: "Pocket POP Keychain Wednesday - Wednesday" passa o travão 2 (duas
 *  "palavras" a seguir ao strip, sem contar o alias), e só o dash-repetido, a correr
 *  depois, colapsa para "Wednesday". Sem este PR essa mesma frase colapsava para
 *  "Pocket POP Keychain Wednesday" — aceitável. Com este PR, para "Wednesday" — não. A
 *  causa é nossa mesmo que a regra que dispara o colapso não seja. */
function aliasColideNoFinal(texto, aliasesNorm) {
  const t = String(texto || "").trim();
  if (!t) return false;
  return aliasesNorm.has(normalizeForMatch(t));
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
 * @param {{ manterPrefixo?: boolean }} [opts] — `manterPrefixo` salta o passo do
 *  prefixo de formato por inteiro (usado pela passagem 2 de {@link resolveTitleCollisions}
 *  para reverter o strip num produto que colidiu com outro; o resto do pipeline de
 *  limpeza corre na mesma, só o prefixo fica).
 * @returns {{ result: string, firedRules: string[] }} — firedRules regista, por ordem,
 *  cada regra que efetivamente mudou o texto (para o dry-run dirigido, Tarefa 10b).
 */
export function cleanProductTitleWithTrace(product = {}, opts = {}) {
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
  const aliasesNorm = new Set(aliases.map((a) => normalizeForMatch(a)));

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
  if (opts.manterPrefixo) {
    firedRules.push("colisao-revertida");
  } else {
    while (passagens < MAX_PASSAGENS_PREFIXO) {
      const listaAplicavel = product.resolvedFormat ? undefined : NOISE_PREFIXES;
      const candidato = listaAplicavel ? stripFormatPrefix(t, listaAplicavel) : stripFormatPrefix(t);
      if (candidato === t) {
        // Nada saiu nesta passagem. Se havia prefixo de FORMATO e não há onde o guardar,
        // foi a guarda — regista-se para o relatório o poder contar à parte.
        if (!product.resolvedFormat && stripFormatPrefix(t) !== t) travadoPelaGuarda = true;
        break;
      }
      if (!sobraSuficiente(candidato, aliasesNorm)) {
        travaoMinimo = true; // travão 2 — o que sobrava não chegava
        break;
      }
      t = candidato;
      passagens += 1;
    }
    if (passagens > 0) firedRules.push("prefixo-formato");
    if (travadoPelaGuarda) firedRules.push("prefixo-formato-travado");
  }

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

  // Travão 3 — só entra em jogo se ESTE laço tirou alguma coisa (passagens > 0): sem
  // isso não há strip nenhum para reverter, e opts.manterPrefixo já garante que a
  // chamada recursiva abaixo nunca volta aqui com passagens > 0 (o laço nem corre).
  if (passagens > 0 && aliasColideNoFinal(t, aliasesNorm)) {
    const revertido = cleanProductTitleWithTrace(product, { manterPrefixo: true });
    return {
      result: revertido.result,
      firedRules: [...revertido.firedRules, "prefixo-formato-travado-final"],
      prefixoPassagens: 0,
      prefixoTravaoMinimo: true,
    };
  }

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

/**
 * Briefing backend 15/09/2026 · B0, correção "strip com consciência de colisão".
 *
 * Invariante novo: O LIMPADOR NUNCA TORNA DOIS PRODUTOS INDISTINGUÍVEIS PELO TÍTULO.
 * Quando vários formatos do MESMO personagem ("POP figure", "Blister 4 figures Bitty
 * POP", "Pocket POP Keychain") só se distinguem pelo prefixo, tirar o prefixo a todos
 * colapsa-os no mesmo texto — e o prefixo, aí, deixa de ser ruído: é a única coisa que
 * diferencia os produtos no título, no carrinho, no email de confirmação, na pesquisa e
 * no separador do browser (a PDP tem o slot de formato ao lado; esses outros sítios só
 * têm o título).
 *
 * Duas passagens, determinístico, independente da ordem de entrada:
 *   1. Calcula o cleanTitle candidato para TODOS os produtos do lote, sem escrever.
 *   2. Agrupa por candidato (normalizeForMatch, para não deixar acento/caixa criar
 *      grupos falsos). Todo o grupo com mais de um membro reverte o strip — em TODOS os
 *      membros, não só nos excedentes: deixar um sem prefixo e os irmãos com prefixo
 *      seria assimétrico e dependeria de qual deles o cursor visita primeiro.
 *
 * Pura — sem I/O, sem Prisma. Quem chama decide o alcance do lote (loja inteira, uma
 * página, um grupo de teste); o pass 2 só precisa de ver, de cada vez, todos os
 * candidatos que PODEM colidir entre si.
 *
 * @param {Array<{ key: string, title?: string, resolvedFranchise?: string|null,
 *                  resolvedLine?: string|null, resolvedFormat?: string|null }>} rows
 * @returns {Array<{ key: string, result: string, firedRules: string[],
 *                    prefixoPassagens: number, colisaoRevertida: boolean }>} — mesma
 *  ordem de `rows`.
 */
export function resolveTitleCollisions(rows) {
  // Confirmado (briefing 15/09/2026 · B0, revisão) — `.result` já é o `cleanTitle`
  // FINAL de `cleanProductTitleWithTrace` (passa pelo travão 3 antes de sair da
  // função), não o candidato intermédio do laço do prefixo. Agrupar por aqui é
  // agrupar pelo texto que realmente vai para a loja — sem isto, o mesmo bug do
  // ponto de avaliação existiria aqui também, e não tinha dado sinal na medição.
  const pass1 = rows.map((row) => ({ row, ...cleanProductTitleWithTrace(row) }));

  const grupos = new Map(); // normalizeForMatch(candidato) -> índices em pass1
  pass1.forEach((p, i) => {
    const norm = normalizeForMatch(p.result);
    if (!norm) return; // vazio não é colisão, é outra falha — fora deste invariante
    if (!grupos.has(norm)) grupos.set(norm, []);
    grupos.get(norm).push(i);
  });

  const revert = new Set();
  for (const indices of grupos.values()) {
    if (indices.length > 1) for (const i of indices) revert.add(i);
  }

  return pass1.map((p, i) => {
    if (!revert.has(i)) {
      return { key: p.row.key, result: p.result, firedRules: p.firedRules, prefixoPassagens: p.prefixoPassagens, colisaoRevertida: false };
    }
    const revertido = cleanProductTitleWithTrace(p.row, { manterPrefixo: true });
    return { key: p.row.key, result: revertido.result, firedRules: revertido.firedRules, prefixoPassagens: 0, colisaoRevertida: true };
  });
}
