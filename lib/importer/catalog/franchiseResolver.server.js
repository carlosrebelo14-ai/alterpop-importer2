/**
 * franchiseResolver — resolve o universo (franquia) de um produto em três camadas.
 * A primeira que produzir resultado ganha; não se acumulam.
 *
 *   Camada 1  mapa de refs      product.franchiseRefs vs FRANCHISE_UNIVERSES[].refs
 *   Camada 2  padrões de título product.title vs FRANCHISE_UNIVERSES[].titlePatterns
 *   Camada 3  vazio             nada encontrado — NÃO inventar, NÃO usar `licence`/`franchises`
 *
 * Função pura, sem I/O. `.server.js` só para ficar fora do bundle de cliente.
 *
 * Saída: um universo por produto (string única). O metafield alterpop.franchise é
 * list.single_line_text_field, mas quem escreve embrulha em [franchise] — a lista só leva
 * um 2.º valor em crossover genuíno, decidido à mão, nunca por ambiguidade aqui.
 *
 * Ref: docs/PLANO-normalizacao-franquias.md (Fase 3) · docs/normalizacao-franquias.md
 */
import {
  FRANCHISE_UNIVERSES,
  FRANCHISE_PRECEDENCE,
} from "./franchiseUniverses.js";
import { FRANCHISE_LINES } from "./franchiseLines.js";

/** Saída canónica em NFC — o valor entra em alterpop.franchise / alterpop.line e nas
 *  condições EQUALS das coleções, comparadas por code point (ENTREGA 2 §4). "Pokémon"
 *  fica sempre U+00E9, nunca e + U+0301. */
const nfc = (s) => (s == null ? s : String(s).normalize("NFC"));

/** Prefixos de formato removidos do início do título antes da camada 2 (spec §Camada 2).
 *  Vocabulário fechado observado no feed. Ordenados por comprimento desc — o mais
 *  específico primeiro ("Blister 4 figures Bitty POP" antes de "POP figure"). */
const FORMAT_PREFIXES = [
  "Blister 4 figures Bitty POP",
  "Blister 3 figures Bitty POP",
  "Blister 2 figures Bitty POP",
  "Blister figures Bitty POP",
  "Display Bitty POP",
  "Pocket POP Keychain",
  "Figure POP",
  "POP figure",
  "Loungefly",
  "Blind box",
  "Assorted",
  "Deluxe",
  "Set",
  // "Latino" (locale do fornecedor) — Decisão 8, caso obrigatório "Latino Pokemon
  // Mega-Charizard X…".
  "Latino",
].sort((a, b) => b.length - a.length);

/** lowercase + sem acentos + tudo o que não é [a-z0-9] vira um espaço + trim.
 *  "Spider-Man" e "Spider Man" colapsam para "spider man"; "Spiderman" fica "spiderman"
 *  (por isso a tabela lista as três variantes como padrões distintos). */
function normText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** ref do feed → chave só-alfanumérica. "One Piece"/"Onepiece" → "onepiece". */
function normRef(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

/** Camada 1: normRef → universo. Colisões entre universos diferentes são erro de
 *  configuração (validado no teste); dentro do mesmo universo é inofensivo. */
const REF_INDEX = (() => {
  const map = new Map();
  for (const u of FRANCHISE_UNIVERSES) {
    for (const ref of u.refs) {
      const key = normRef(ref);
      if (key) map.set(key, u);
    }
  }
  return map;
})();

/** Camada 2: candidatos {universo, needle} de todos os titlePatterns, ordenados por
 *  [priority desc, comprimento do padrão desc, ordem na tabela]. `needle` já vem com
 *  espaços a delimitar — o match é ` title `.includes(` needle `), i.e. sequência de
 *  palavras inteiras. Assim "Up"/"300"/"Kong" não apanham dentro de outras palavras. */
const TITLE_CANDIDATES = (() => {
  const list = [];
  FRANCHISE_UNIVERSES.forEach((u, idx) => {
    for (const pattern of u.titlePatterns) {
      const norm = normText(pattern);
      if (!norm) continue;
      list.push({
        universe: u,
        pattern,
        needle: ` ${norm} `,
        priority: u.priority || 0,
        len: norm.length,
        idx,
      });
    }
  });
  list.sort(
    (a, b) => b.priority - a.priority || b.len - a.len || a.idx - b.idx
  );
  return list;
})();

/** Universo mapeado por este ref cru, ou null. Exposto para o report mode distinguir
 *  "ref que a camada 1 devia ter apanhado" de "ref sem entrada na tabela". */
export function lookupRef(raw) {
  return REF_INDEX.get(normRef(raw)) || null;
}

/** Camada 2 isolada: universo que o TÍTULO por si só apontaria, ignorando refs por
 *  completo. Só para diagnóstico (Tarefa 11 — detetor de contradição título/ref);
 *  nunca usado para decidir a franquia publicada, que continua a sair de resolveFranchise(). */
export function titleOnlyUniverse(product, opts = {}) {
  const titleSource = opts.titleSource ?? product?.titleSource;
  const titleGated =
    opts.titleLayerOnlyForSupplierTitles && titleSource && titleSource !== "supplier";
  if (titleGated) return null;
  const haystack = ` ${normText(stripFormatPrefix(product?.title || ""))} `;
  const hit = firstTitleHit(haystack);
  return hit ? { franchise: hit.universe.name, handle: hit.universe.handle, matchedOn: hit.pattern } : null;
}

// ── Lines — sub-divisões dentro de um universo (ENTREGA 2) ────────────────────
// Mesma máquina das camadas 1 e 2, mas o resultado não é um universo: é
// { line, parent }. Quando bate, o PARENT ganha o slot de franquia e o produto
// leva também `line`. Ex.: Mandalorian/Grogu/Ahsoka → franchise "Star Wars" + line
// "The Mandalorian".

/** normRef → line. */
const LINE_REF_INDEX = (() => {
  const map = new Map();
  for (const l of FRANCHISE_LINES) {
    for (const ref of l.refs || []) {
      const key = normRef(ref);
      if (key) map.set(key, l);
    }
  }
  return map;
})();

/** candidatos {line, needle} de todos os titlePatterns das Lines, ordenados por
 *  comprimento desc (o match é ` haystack `.includes(` needle `), palavra inteira). */
const LINE_TITLE_CANDIDATES = (() => {
  const list = [];
  FRANCHISE_LINES.forEach((l, idx) => {
    for (const pattern of l.titlePatterns || []) {
      const norm = normText(pattern);
      if (!norm) continue;
      list.push({ line: l, pattern, needle: ` ${norm} `, len: norm.length, idx });
    }
  });
  list.sort((a, b) => b.len - a.len || a.idx - b.idx);
  return list;
})();

/** Parent (universo) de uma Line → { name, handle }. O parent TEM de existir na tabela
 *  de universos; se não existir é erro de configuração (validado em checkLineInvariants). */
function parentOf(line) {
  const u = FRANCHISE_UNIVERSES.find((x) => x.name === line.parent);
  return u ? { name: u.name, handle: u.handle } : { name: line.parent, handle: null };
}

/** Primeira Line que bate por ref (franchiseRefs) ou por título (haystack já normalizado).
 *  Devolve { line, via: 1|2, matchedOn } ou null. Ref tem precedência sobre título. */
function detectLine(refs, haystack) {
  for (const raw of refs) {
    const l = LINE_REF_INDEX.get(normRef(raw));
    if (l) return { line: l, via: 1, matchedOn: raw };
  }
  for (const cand of LINE_TITLE_CANDIDATES) {
    if (haystack.includes(cand.needle)) {
      return { line: cand.line, via: 2, matchedOn: cand.pattern };
    }
  }
  return null;
}

/** Erros de configuração das Lines (parent inexistente, colisão de handle com universo,
 *  ref partilhada com um universo). Vazio = ok. Usado nos testes. */
export function checkLineInvariants() {
  const problems = [];
  const universeHandles = new Set(FRANCHISE_UNIVERSES.map((u) => u.handle));
  const universeNames = new Set(FRANCHISE_UNIVERSES.map((u) => u.name));
  for (const l of FRANCHISE_LINES) {
    if (!universeNames.has(l.parent)) {
      problems.push(`line "${l.line}": parent "${l.parent}" não existe em FRANCHISE_UNIVERSES`);
    }
    if (universeHandles.has(l.handle)) {
      problems.push(`line "${l.line}": handle "${l.handle}" colide com um universo`);
    }
    for (const ref of l.refs || []) {
      if (REF_INDEX.has(normRef(ref))) {
        problems.push(`line "${l.line}": ref "${ref}" também está mapeada por um universo`);
      }
    }
  }
  return problems;
}

/** handle → posição na tabela (desempate estável). */
const UNIVERSE_ORDER = new Map(FRANCHISE_UNIVERSES.map((u, i) => [u.handle, i]));

/** handle "perdedor" → Set de handles que o vencem por precedência. */
const PRECEDENCE_WINNERS_OVER = (() => {
  const m = new Map();
  for (const rule of FRANCHISE_PRECEDENCE) {
    if (!m.has(rule.over)) m.set(rule.over, new Set());
    m.get(rule.over).add(rule.winner);
  }
  return m;
})();

/** Melhor de um conjunto de universos: maior priority, depois ordem na tabela. */
function bestOf(universes) {
  return [...universes].sort(
    (a, b) => (b.priority || 0) - (a.priority || 0) ||
      (UNIVERSE_ORDER.get(a.handle) ?? 1e9) - (UNIVERSE_ORDER.get(b.handle) ?? 1e9)
  )[0];
}

/** Primeiro candidato de título que bate no haystack normalizado, ou null. */
function firstTitleHit(haystack) {
  for (const cand of TITLE_CANDIDATES) {
    if (haystack.includes(cand.needle)) return cand;
  }
  return null;
}

/** Qual entrada de FORMAT_PREFIXES bate no início do título, ou null. Exposta para a
 *  Tarefa 31 (Decisão 16) — censo de prefixos distintos com contagem, sem duplicar a
 *  lógica de match. */
export function matchFormatPrefix(title) {
  const t = String(title || "").trim();
  const tl = t.toLowerCase();
  for (const prefix of FORMAT_PREFIXES) {
    const p = prefix.toLowerCase();
    if (tl.startsWith(p + " ") || tl === p) return prefix;
  }
  return null;
}

/** Remove um (só um) prefixo de formato do início do título. */
export function stripFormatPrefix(title) {
  const t = String(title || "").trim();
  const prefix = matchFormatPrefix(t);
  if (!prefix) return t;
  if (t.length === prefix.length) return "";
  return t.slice(prefix.length).trim();
}

/**
 * Universo base (camadas 1–3), SEM Lines. Preservado tal como estava; a lógica de Line
 * assenta por cima em resolveFranchise().
 * @returns {{ franchise: string|null, handle: string|null, layer: 1|2|3, matchedOn: string|null, haystack: string }}
 */
function resolveUniverse(product, opts = {}) {
  // ── Título (calculado sempre — a camada 1 precisa dele para a precedência) ─────
  const titleSource = opts.titleSource ?? product?.titleSource;
  const titleGated =
    opts.titleLayerOnlyForSupplierTitles && titleSource && titleSource !== "supplier";
  const haystack = titleGated
    ? " "
    : ` ${normText(stripFormatPrefix(product?.title || ""))} `;
  const titleHit = titleGated ? null : firstTitleHit(haystack);

  // ── Camada 1 — refs ──────────────────────────────────────────────────────────
  const refs = Array.isArray(product?.franchiseRefs) ? product.franchiseRefs : [];
  const refHits = [];
  const seen = new Set();
  for (const raw of refs) {
    const u = REF_INDEX.get(normRef(raw));
    if (u && !seen.has(u.handle)) {
      seen.add(u.handle);
      refHits.push(u);
    }
  }

  if (refHits.length) {
    let pick = bestOf(refHits);
    let matchedOn = refs.find((r) => REF_INDEX.get(normRef(r))?.handle === pick.handle);

    // Precedência: se o título aponta um universo que VENCE por precedência algum dos
    // universos apanhados por ref, esse ganha. Resolve o caso "produto com ref/token
    // 'Star Wars' mas título 'The Mandalorian Grogu'" — 231 casos no catálogo real.
    if (titleHit) {
      const overSome = refHits.some((u) =>
        PRECEDENCE_WINNERS_OVER.get(u.handle)?.has(titleHit.universe.handle)
      );
      if (overSome && !seen.has(titleHit.universe.handle)) {
        pick = titleHit.universe;
        matchedOn = `${titleHit.pattern} (precedência s/ ref)`;
      }
    }
    // Entre os próprios refHits a precedência também conta (ex.: refs de X-Men + Avengers).
    for (const u of refHits) {
      if (PRECEDENCE_WINNERS_OVER.get(pick.handle)?.has(u.handle)) {
        pick = u;
        matchedOn = refs.find((r) => REF_INDEX.get(normRef(r))?.handle === u.handle);
      }
    }

    return { franchise: pick.name, handle: pick.handle, layer: 1, matchedOn: matchedOn || null, haystack };
  }

  // ── Camada 2 — título ────────────────────────────────────────────────────────
  if (titleHit) {
    return {
      franchise: titleHit.universe.name,
      handle: titleHit.universe.handle,
      layer: 2,
      matchedOn: titleHit.pattern,
      haystack,
    };
  }

  // ── Camada 3 — vazio ────────────────────────────────────────────────────────
  return { franchise: null, handle: null, layer: 3, matchedOn: null, haystack };
}

/**
 * Resolve universo + Line de um produto.
 *
 * Camadas 1–3 (resolveUniverse) dão o universo base. Por cima corre a deteção de Line
 * (franchiseLines.js): se um ref/token de Line bate, o PARENT da Line ganha o slot de
 * franquia e o produto leva também `line`. Ex.: ref "Mandalorian" / título "…Grogu…"
 * → franchise "Star Wars", line "The Mandalorian".
 *
 * Saída em NFC (o valor vai para alterpop.franchise / alterpop.line e as condições das
 * coleções, comparadas por code point).
 *
 * @param {{ franchiseRefs?: string[], title?: string }} product
 * @param {{ titleLayerOnlyForSupplierTitles?: boolean, titleSource?: string }} [opts]
 * @returns {{ franchise: string|null, handle: string|null, layer: 1|2|3, matchedOn: string|null, line: string|null, lineHandle: string|null }}
 */
export function resolveFranchise(product, opts = {}) {
  const base = resolveUniverse(product, opts);
  const refs = Array.isArray(product?.franchiseRefs) ? product.franchiseRefs : [];
  const lineHit = detectLine(refs, base.haystack);

  if (!lineHit) {
    return {
      franchise: nfc(base.franchise),
      handle: base.handle,
      layer: base.layer,
      matchedOn: base.matchedOn,
      line: null,
      lineHandle: null,
    };
  }

  // Line bate → o parent ganha a franquia. Se o universo base já era o parent, mantém-se
  // a camada/matchedOn; se o base deu outro universo ou vazio, o parent passa a valer e a
  // camada reflete como a Line bateu (1 = ref, 2 = título).
  const parent = parentOf(lineHit.line);
  const parentWasBase = base.handle === parent.handle;

  return {
    franchise: nfc(parent.name),
    handle: parent.handle,
    layer: parentWasBase ? base.layer : lineHit.via,
    matchedOn: parentWasBase
      ? base.matchedOn
      : `${lineHit.matchedOn} (line → parent)`,
    line: nfc(lineHit.line.line),
    lineHandle: lineHit.line.handle,
  };
}

/**
 * Verifica que as regras de FRANCHISE_PRECEDENCE se cumprem no ordenamento efetivo dos
 * candidatos da camada 2 (o `winner` é testado antes do `over`). Usado pelos testes;
 * barato o suficiente para correr também no arranque de um script.
 * @returns {string[]} lista de violações (vazia = ok)
 */
export function checkPrecedenceInvariants() {
  const firstIndexByHandle = new Map();
  TITLE_CANDIDATES.forEach((c, i) => {
    if (!firstIndexByHandle.has(c.universe.handle)) {
      firstIndexByHandle.set(c.universe.handle, i);
    }
  });
  const problems = [];
  for (const rule of FRANCHISE_PRECEDENCE) {
    const w = firstIndexByHandle.get(rule.winner);
    const o = firstIndexByHandle.get(rule.over);
    if (w == null) problems.push(`precedência: handle "${rule.winner}" não existe`);
    else if (o == null) problems.push(`precedência: handle "${rule.over}" não existe`);
    else if (w >= o) {
      problems.push(
        `precedência: "${rule.winner}" (pos ${w}) devia vir antes de "${rule.over}" (pos ${o}) — ${rule.reason}`
      );
    }
  }
  return problems;
}

/** Colisões de ref entre universos diferentes (erro de configuração). */
export function checkRefIndexCollisions() {
  const seen = new Map();
  const problems = [];
  for (const u of FRANCHISE_UNIVERSES) {
    for (const ref of u.refs) {
      const key = normRef(ref);
      if (!key) continue;
      const prev = seen.get(key);
      if (prev && prev !== u.handle) {
        problems.push(`ref "${ref}" (${key}) mapeada por "${prev}" e "${u.handle}"`);
      } else {
        seen.set(key, u.handle);
      }
    }
  }
  return problems;
}

// A camada 3 "chapéu" (Disney/Marvel, Tarefa 14/14b) foi arquivada na Tarefa 27:
// código morto e nunca ligado apodrece e confunde quem lê a seguir. Se for retomada,
// é trabalho novo, não um "reativar" — não há histórico a recuperar aqui de propósito.
