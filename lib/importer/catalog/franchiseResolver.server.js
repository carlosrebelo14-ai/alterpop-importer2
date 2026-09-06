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

/** Remove um (só um) prefixo de formato do início do título. */
export function stripFormatPrefix(title) {
  const t = String(title || "").trim();
  const tl = t.toLowerCase();
  for (const prefix of FORMAT_PREFIXES) {
    const p = prefix.toLowerCase();
    if (tl.startsWith(p + " ")) return t.slice(prefix.length).trim();
    if (tl === p) return "";
  }
  return t;
}

/**
 * @param {{ franchiseRefs?: string[], title?: string }} product
 * @param {{ titleLayerOnlyForSupplierTitles?: boolean, titleSource?: string }} [opts]
 * @returns {{ franchise: string|null, handle: string|null, layer: 1|2|3, matchedOn: string|null }}
 */
export function resolveFranchise(product, opts = {}) {
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

    return { franchise: pick.name, handle: pick.handle, layer: 1, matchedOn: matchedOn || null };
  }

  // ── Camada 2 — título ────────────────────────────────────────────────────────
  if (titleHit) {
    return {
      franchise: titleHit.universe.name,
      handle: titleHit.universe.handle,
      layer: 2,
      matchedOn: titleHit.pattern,
    };
  }

  // ── Camada 3 — vazio ────────────────────────────────────────────────────────
  return { franchise: null, handle: null, layer: 3, matchedOn: null };
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
