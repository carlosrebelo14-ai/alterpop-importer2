/**
 * Aprovação por personagem (briefing backend 04/11/2026) — lógica pura de seleção,
 * relatório e plano de escrita/reversão. Sem Prisma, sem Shopify, sem escrita: os
 * scripts scripts/catalog/character-approve.js e character-approve-revert.js tratam do
 * I/O e chamam isto. Coberto por scripts/tests/character-approve.test.js.
 *
 * Fonte: a lista de 09/10 (character-import-2026-10-09.json), sem cópia (revisão do
 * arquiteto, 04/11). O que o briefing de 04/11 acrescenta vive aqui: aliases
 * obrigatórios (BRIEFING_ALIASES), nomes de risco (RISK_NAMES) e a origem (ORIGIN).
 *
 * Diferenças para a ronda de 09/10 (characterImportSelect.js):
 *  - sem tetos: entram TODOS os SKUs elegíveis;
 *  - custo bruto (distributorPrice = precio_distribuidores) > 5,00 €;
 *  - stock não filtra, só se conta;
 *  - The Mandalorian exige só resolvedFranchise Star Wars (a Line não é obrigatória) e
 *    Star Wars deixa de excluir a Line;
 *  - âmbito: filtro de coleccionáveis (15/09, PR #76) OU Loungefly (exceção);
 *  - PENDING apagados no admin entram como qualquer candidato e contam-se à parte;
 *  - órfãos da passagem B NÃO entram: nada grava resolvedFranchise pela via do
 *    personagem (B7 só aplica a passagem A), e nenhum produto aprovado aqui chega à
 *    loja sem alterpop.franchise. Ficam numa lista à parte;
 *  - escrita direta na fila com marca de origem, revertível pela mesma marca.
 *
 * Correspondência — nome ou alias no cleanTitle (fallback title), palavra inteira, sem
 * distinção de maiúsculas nem de acentos, após NFC (normalizeForMatch de 09/10).
 */
import { CHARACTER_ALIASES } from "./characterVocabulary.js";
import { isCollectibleVendor } from "./manufacturerTierResolver.server.js";
import { normalizeForMatch } from "./characterImportSelect.js";

export { normalizeForMatch };

/** Marca de origem gravada em metadata.importOrigin e lida pelo revert. */
export const ORIGIN = "character-import-2026-11-04";
/** Custo bruto mínimo, exclusivo: entra só custo > 5,00 €. */
export const MIN_COST_EXCLUSIVE = 5;
/** Segundos por produto no publish (medição do briefing). */
export const PUBLISH_SECONDS_PER_PRODUCT = 5.3;
export const SAMPLE_SIZE = 5;
export const TOP_EXCLUDED_VENDORS = 20;

/** Campos de metadata que a escrita grava e a reversão lê. */
export const META_ORIGIN = "importOrigin";
export const META_PREVIOUS = "importPrevious";

/** Tabela "Aliases obrigatórios" do briefing de 04/11, por nome da lista de 09/10. */
export const BRIEFING_ALIASES = Object.freeze({
  "fato simbionte": ["Symbiote Suit", "Black Suit"],
  "Titã Colossal": ["Colossal Titan"],
  "Titã Blindado": ["Armored Titan", "Armoured Titan"],
  "Zaku II de Char": ["Char's Zaku", "Char Zaku"],
  "Nazgûl": ["Nazgul", "Witch-King", "Witch King", "Ringwraith"],
  Gogeta: ["Vegito", "Vegetto"],
  "Jean Grey": ["Phoenix"],
  "Spider-Man": ["Spiderman", "Spider Man"],
  "Spider-Gwen": ["Ghost-Spider", "Gwen Stacy"],
  "Obi-Wan Kenobi": ["Obi Wan", "Obi-Wan"],
  "R2-D2": ["R2D2"],
  "C-3PO": ["C3PO"],
  "EVA-01": ["Unit-01", "Unit 01"],
  "EVA-02": ["Unit-02", "Unit 02"],
  "No-Face": ["Kaonashi"],
  "Iron Man": ["Ironman"],
  "Professor X": ["Charles Xavier"],
  "Doctor Strange": ["Dr. Strange"],
  "Doctor Octopus": ["Doc Ock", "Dr. Octopus"],
  "Doctor Doom": ["Dr. Doom"],
  Alien: ["Aliens", "Little Green Men"],
  "Yuji Itadori": ["Itadori"],
});

/** Nomes de risco do briefing: contagem e 5 títulos de amostra no dry-run. */
export const RISK_NAMES = Object.freeze([
  "Mew", "Cell", "Law", "Ace", "Ron", "Max", "Will", "Mike", "Rei", "Mari", "San", "Pain", "Jazz", "Unicorn",
  "Angel", "Bond", "Power", "Rex", "Steve", "Howl", "Luna", "Storm", "Rogue", "Leonardo", "Harry", "Alien", "Eleven",
]);

/**
 * Epónimos contidos numa frase maior da franquia (revisão do arquiteto, 04/11, bloqueador 1).
 * Para estes nomes retira-se UMA vez a frase (a primeira ocorrência, a que aparece mais cedo
 * no título) e procura-se o nome no resto. Os outros nomes contam no título completo. Os
 * nomes iguais ao universo (Batman, Superman, Spider-Man, Stitch) ficam como estão.
 */
export const FRANCHISE_PHRASES = Object.freeze({
  Harry: ["Harry Potter"],
  Naruto: ["Naruto Shippuden", "Naruto Shippuuden"],
});

/** Têxtil (bloqueador 2): palavra inteira no título. "Tshirt" junta-se como grafia do feed. */
export const TEXTILE_WORDS = Object.freeze(["Tee", "T-Shirt", "Tshirt", "Hoodie", "Sweatshirt", "Socks", "Cap", "Beanie"]);
/** Têxtil (bloqueador 2): sufixo de tamanho no fim do título. */
export const SIZE_SUFFIXES = Object.freeze(["XS", "S", "M", "L", "XL", "XXL", "XXXL"]);
export const TEXTILE_SAMPLE_SIZE = 10;
/** Âmbitos com detalhe por personagem no log (filtro, preço, universo). */
export const DETAIL_SCOPES = Object.freeze(["The Lord of the Rings", "Studio Ghibli"]);

/** Cabeçalho do CSV — colunas do briefing primeiro, depois as de leitura. */
export const CSV_COLUMNS = ["SKU", "titulo", "franquia", "personagem", "custo_bruto", "fabricante", "stock", "prioridade", "ambito", "loungefly", "apagado_no_admin"];
/** Cabeçalho do CSV dos órfãos (fora do execute). */
export const ORPHAN_CSV_COLUMNS = ["SKU", "titulo", "franquia_do_personagem", "personagem", "custo_bruto", "fabricante", "stock", "elegivel_sem_franquia", "motivo"];

const nfc = (s) => (s == null ? s : String(s).normalize("NFC"));
const unique = (list) => [...new Set(list)];

/**
 * Chave de universo. "×" e "x" valem o mesmo ("Spy × Family" = "Spy x Family").
 * @param {unknown} name
 */
export function universeKey(name) {
  return normalizeForMatch(String(name ?? "").replace(/[×✕✖]/g, " x "));
}

/**
 * Âmbitos (uma linha da tabela = um âmbito) a partir da lista de 09/10. A Line e as
 * excludeLines do ficheiro ficam só como rótulo: o universo é o que manda.
 * Cada frase guarda a proveniência: "lista" (nome, aliases do ficheiro, briefing) ou
 * "b7" (só no vocabulário B7) — o dry-run reporta as segundas à parte.
 * @param {object} data conteúdo de character-import-2026-10-09.json
 * @param {{ vocabAliases?: Record<string,string[]>, briefingAliases?: Record<string,string[]>, riskNames?: readonly string[] }} [opts]
 */
export function buildApprovalScopes(data, { vocabAliases = CHARACTER_ALIASES, briefingAliases = BRIEFING_ALIASES, riskNames = RISK_NAMES } = {}) {
  const risk = new Set(riskNames);
  return data.universes.map((row, scopeIndex) => {
    const universe = nfc(row.universe);
    const line = row.line || null;
    const names = row.characters.map((c, nameIndex) => {
      const listAliases = unique([c.name, ...(c.aliases || []), ...(briefingAliases[c.name] || [])]);
      const listPhrases = new Set(listAliases.map(normalizeForMatch).filter(Boolean));
      const b7Aliases = unique(vocabAliases[c.name] || []).filter((a) => !listPhrases.has(normalizeForMatch(a)));
      /** frase normalizada → { alias, via } */
      const phraseInfo = new Map();
      for (const a of listAliases) {
        const p = normalizeForMatch(a);
        if (p && !phraseInfo.has(p)) phraseInfo.set(p, { alias: a, via: "lista" });
      }
      for (const a of b7Aliases) {
        const p = normalizeForMatch(a);
        if (p && !phraseInfo.has(p)) phraseInfo.set(p, { alias: a, via: "b7" });
      }
      return {
        key: `${scopeIndex}:${nameIndex}`,
        scopeIndex,
        nameIndex,
        name: c.name,
        priority: c.priority === 1 ? 1 : 2,
        mode: c.mode === "A+B" ? "A+B" : "A",
        risk: risk.has(c.name),
        franchisePhrases: (FRANCHISE_PHRASES[c.name] || []).map(normalizeForMatch).filter(Boolean),
        aliases: [...listAliases, ...b7Aliases],
        phraseInfo,
        phrases: [...phraseInfo.keys()],
      };
    });
    return { index: scopeIndex, universe, universeKey: universeKey(universe), line, label: line ? `${universe} / ${line}` : universe, names };
  });
}

/** Produto sem universo resolvido. */
export const isOrphan = (row) => row.resolvedFranchise == null || String(row.resolvedFranchise).trim() === "";

/**
 * Loungefly — exceção ao filtro de âmbito. Deteção por fabricante (vendor), formato
 * (resolvedFormat = alterpop.format) ou prefixo do título original. O CatalogProduct
 * não tem coluna de marca; o vendor faz as duas vezes.
 * @returns {{ loungefly: boolean, via: "vendor"|"formato"|"titulo"|null }}
 */
export function detectLoungefly(row) {
  const has = (v) => ` ${normalizeForMatch(v)} `.includes(" loungefly ");
  if (has(row.vendor)) return { loungefly: true, via: "vendor" };
  if (has(row.resolvedFormat)) return { loungefly: true, via: "formato" };
  const original = normalizeForMatch(row.originalTitle || row.title);
  if (original === "loungefly" || original.startsWith("loungefly ")) return { loungefly: true, via: "titulo" };
  return { loungefly: false, via: null };
}

/**
 * Filtro de âmbito: coleccionáveis (COLLECTOR/CORE) ou Loungefly.
 * @returns {{ pass: boolean, base: boolean, loungefly: boolean, via: string|null }}
 */
export function scopeFilter(row) {
  const base = isCollectibleVendor(row.vendor);
  const lf = detectLoungefly(row);
  return { pass: base || lf.loungefly, base, loungefly: lf.loungefly, via: lf.via };
}

const TEXTILE_NEEDLES = TEXTILE_WORDS.map((w) => ` ${normalizeForMatch(w)} `);
const SIZE_SET = new Set(SIZE_SUFFIXES.map((x) => x.toLowerCase()));

/**
 * Têxtil por título (cleanTitle, fallback title): palavra da lista ou tamanho no fim.
 * "POP & Tee" sai por "Tee". Quem chama não aplica isto à Loungefly.
 * @returns {{ textile: boolean, via: string|null }}
 */
export function detectTextile(row) {
  const norm = normalizeForMatch(row.cleanTitle || row.title);
  const hay = ` ${norm} `;
  const word = TEXTILE_NEEDLES.find((n) => hay.includes(n));
  if (word) return { textile: true, via: word.trim() };
  const last = norm.split(" ").pop();
  if (last && SIZE_SET.has(last)) return { textile: true, via: `tamanho ${last.toUpperCase()}` };
  return { textile: false, via: null };
}

/** Retira do título (já normalizado e entre espaços) a primeira ocorrência de uma das frases. */
export function removeFirstPhrase(hay, phrases) {
  let at = -1;
  let len = 0;
  for (const p of phrases) {
    const n = ` ${p} `;
    const i = hay.indexOf(n);
    if (i >= 0 && (at < 0 || i < at || (i === at && n.length > len))) {
      at = i;
      len = n.length;
    }
  }
  return at < 0 ? hay : `${hay.slice(0, at)} ${hay.slice(at + len)}`;
}

/**
 * Índice de frases → nomes, para procurar cada título uma só vez. Devolve, por nome
 * que bate, as frases que bateram (para saber se veio só de um alias do B7).
 */
export function buildMatcher(scopes) {
  const needles = new Map();
  const special = [];
  for (const s of scopes) {
    for (const e of s.names) {
      if (e.franchisePhrases?.length) {
        special.push(e);
        continue;
      }
      for (const p of e.phrases) {
        const n = ` ${p} `;
        if (!needles.has(n)) needles.set(n, []);
        needles.get(n).push(e);
      }
    }
  }
  const list = [...needles.keys()];
  /** @returns {Map<string, object>} key → entrada do nome */
  function match(title) {
    return matchDetailed(title).hits;
  }
  /** @returns {{ hits: Map<string, object>, phrasesByKey: Map<string, string[]> }} */
  function matchDetailed(title) {
    const hay = ` ${normalizeForMatch(title)} `;
    const hits = new Map();
    const phrasesByKey = new Map();
    for (const n of list) {
      if (!hay.includes(n)) continue;
      for (const e of needles.get(n)) {
        hits.set(e.key, e);
        if (!phrasesByKey.has(e.key)) phrasesByKey.set(e.key, []);
        phrasesByKey.get(e.key).push(n.trim());
      }
    }
    // Epónimos dentro da frase da franquia: o nome procura-se no título sem essa frase.
    for (const e of special) {
      const rest = removeFirstPhrase(hay, e.franchisePhrases);
      for (const p of e.phrases) {
        if (!rest.includes(` ${p} `)) continue;
        hits.set(e.key, e);
        if (!phrasesByKey.has(e.key)) phrasesByKey.set(e.key, []);
        phrasesByKey.get(e.key).push(p);
      }
    }
    return { hits, phrasesByKey };
  }
  match.detailed = matchDetailed;
  return match;
}

const byRank = (a, b) => a.priority - b.priority || a.scopeIndex - b.scopeIndex || a.nameIndex - b.nameIndex;

/**
 * Classifica uma linha do catálogo. Ordem fixa dos motivos (o resumo fica estável):
 *   sem_correspondencia → universo_errado → orfao_sem_franquia → estado (REJECTED,
 *   fora da fila, APPROVED, PUBLISHED, SYNC_ERROR) → preco → textil → fora_ambito → candidato.
 * Têxtil não se aplica à Loungefly.
 * Um PENDING apagado no admin é candidato como os outros (`deletedInAdmin: true`).
 * Um órfão da passagem B nunca é candidato: sai com `orfao_sem_franquia` e
 * `orphanEligible` diz se passaria os outros filtros (para a lista à parte).
 * @param {object} row linha de CatalogProduct
 * @param {Map<string, object>} hits resultado do matcher
 * @param {object[]} scopes
 * @param {Map<string, { status: string, deletedAt?: string|null }>} queueBySku
 */
export function classifyRow(row, hits, scopes, queueBySku) {
  if (!hits.size) return { reason: "sem_correspondencia" };
  const rowKey = universeKey(row.resolvedFranchise);
  const orphan = isOrphan(row);
  const inA = [];
  const inB = [];
  for (const e of hits.values()) {
    const scope = scopes[e.scopeIndex];
    if (!orphan && rowKey === scope.universeKey) inA.push(e);
    else if (orphan && e.mode === "A+B") inB.push(e);
  }
  const all = [...hits.values()];
  if (!inA.length && !inB.length) return { reason: "universo_errado", hits: all };
  const source = inA.length ? "A" : "B";
  const matched = (inA.length ? inA : inB).sort(byRank);
  const primary = matched[0];
  const base = { source, matched, primary, hits: all };

  const q = queueBySku.get(row.sku);
  const deletedInAdmin = Boolean(q?.deletedAt);
  let reason = null;
  let scope;
  if (!q) reason = "fora_da_fila";
  else if (q.status === "REJECTED") reason = "rejected";
  else if (q.status !== "PENDING") reason = `estado_${String(q.status).toLowerCase()}`;
  else {
    const cost = Number(row.distributorPrice);
    if (!(Number.isFinite(cost) && cost > MIN_COST_EXCLUSIVE)) reason = "preco";
    else {
      scope = scopeFilter(row);
      const tx = scope.loungefly ? { textile: false } : detectTextile(row);
      if (tx.textile) reason = "textil";
      else if (!scope.pass) reason = "fora_ambito";
    }
  }
  if (source === "B") return { ...base, reason: "orfao_sem_franquia", orphanEligible: reason === null, orphanReason: reason, scope, deletedInAdmin };
  return { ...base, reason, scope, deletedInAdmin };
}

export const REASON_LABELS = {
  sem_correspondencia: "sem correspondência",
  universo_errado: "universo errado (ou sem universo, fora dos 9 da passagem B)",
  orfao_sem_franquia: "órfão da passagem B (sem resolvedFranchise; lista à parte)",
  fora_da_fila: "fora da fila de curadoria",
  rejected: "REJECTED",
  estado_approved: "já APPROVED",
  estado_published: "já PUBLISHED",
  estado_sync_error: "em SYNC_ERROR",
  preco: `custo bruto ≤ ${MIN_COST_EXCLUSIVE.toFixed(2)} € ou sem custo`,
  textil: "têxtil (Tee, T-Shirt, Hoodie, Sweatshirt, Socks, Cap, Beanie ou tamanho no fim)",
  fora_ambito: "fora do filtro de âmbito (fabricante não coleccionável, sem Loungefly)",
};
export const reasonLabel = (r) => REASON_LABELS[r] || r;

function spread(list, n) {
  if (list.length <= n) return list.slice();
  const out = [];
  for (let i = 0; i < n; i++) out.push(list[Math.floor((i * list.length) / n)]);
  return out;
}

const bump = (obj, key, by = 1) => {
  obj[key] = (obj[key] || 0) + by;
};

/**
 * Colector em streaming. `addRow` vê cada linha uma vez; guarda só os candidatos, os
 * órfãos e os contadores. Um SKU conta uma vez em todos os totais, mesmo com vários
 * personagens; a contagem por personagem conta o SKU em cada nome que bate (a soma
 * passa o total).
 * @param {{ scopes: object[], queueBySku: Map<string, object> }} opts
 */
export function createApprovalCollector({ scopes, queueBySku }) {
  const match = buildMatcher(scopes);
  const entries = scopes.flatMap((s) => s.names);
  const entryByKey = new Map(entries.map((e) => [e.key, e]));
  const perName = new Map(
    entries.map((e) => [e.key, { catalog: 0, inUniverse: 0, outUniverse: 0, semUniverso: 0, orphans: 0, orphansEligible: 0, candidates: 0, semFiltro: 0, reasons: {}, matched: [] }])
  );
  /** "key|frase" → { scope, name, alias, inUniverse, candidates, onlyVia } */
  const b7 = new Map();
  const excluded = {};
  const candidates = [];
  const orphans = [];
  const outOfScopeVendors = new Map();
  const textileSeen = [];
  const sizeOnly = [];
  let rowsSeen = 0;
  let semFiltro = 0;
  const seen = new Set();

  function addRow(row) {
    rowsSeen += 1;
    if (seen.has(row.sku)) return;
    seen.add(row.sku);
    const title = row.cleanTitle || row.title;
    const { hits, phrasesByKey } = match.detailed(title);
    if (!hits.size) return;
    const r = classifyRow(row, hits, scopes, queueBySku);
    const rowKey = universeKey(row.resolvedFranchise);
    const matchedKeys = new Set((r.matched || []).map((e) => e.key));
    const isCandidate = r.reason === null;

    for (const e of hits.values()) {
      const st = perName.get(e.key);
      st.catalog += 1;
      if (matchedKeys.has(e.key)) {
        if (r.source === "A") st.inUniverse += 1;
        else {
          st.orphans += 1;
          if (r.orphanEligible) st.orphansEligible += 1;
        }
        bump(st.reasons, r.reason ?? "candidato");
        if (isCandidate) st.candidates += 1;
        if (isCandidate || r.reason === "fora_ambito") st.semFiltro += 1;
        if (e.risk) st.matched.push({ sku: row.sku, title, reason: r.reason, source: r.source });
        if (r.source === "A") {
          const phrases = phrasesByKey.get(e.key) || [];
          const viaB7 = phrases.filter((p) => e.phraseInfo.get(p)?.via === "b7");
          const viaLista = phrases.some((p) => e.phraseInfo.get(p)?.via === "lista");
          for (const p of viaB7) {
            const k = `${e.key}|${p}`;
            if (!b7.has(k)) b7.set(k, { scope: scopes[e.scopeIndex].label, name: e.name, alias: e.phraseInfo.get(p).alias, inUniverse: 0, candidates: 0, onlyVia: 0 });
            const b = b7.get(k);
            b.inUniverse += 1;
            if (isCandidate) {
              b.candidates += 1;
              // O SKU só é candidato por causa deste alias: nenhuma frase da lista e nenhum outro nome do universo.
              if (!viaLista && r.matched.length === 1 && viaB7.length === 1) b.onlyVia += 1;
            }
          }
        }
      } else if (rowKey && rowKey !== scopes[e.scopeIndex].universeKey) {
        st.outUniverse += 1;
        if (e.risk) st.matched.push({ sku: row.sku, title, reason: "universo_errado", universe: row.resolvedFranchise });
      } else if (!rowKey) {
        st.semUniverso += 1;
      }
    }

    if (isCandidate || r.reason === "fora_ambito") semFiltro += 1;
    if (r.reason === "textil") {
      const via = detectTextile(row).via;
      textileSeen.push({ sku: row.sku, title, via });
      // Relatório da regra do tamanho (arquiteto, 04/11 19:44): só os que saem pelo tamanho, sem palavra de têxtil.
      if (via.startsWith("tamanho ")) sizeOnly.push({ sku: row.sku, title, via });
    }
    if (r.reason === "fora_ambito") {
      const v = String(row.vendor || "").trim() || "(sem fabricante)";
      outOfScopeVendors.set(v, (outOfScopeVendors.get(v) || 0) + 1);
    }
    const record = {
      sku: row.sku,
      title,
      vendor: String(row.vendor || "").trim(),
      cost: Number(row.distributorPrice),
      stock: Number(row.stock) || 0,
      resolvedFranchise: row.resolvedFranchise ?? null,
      source: r.source,
      primary: r.primary,
      matched: r.matched,
      scope: r.scope,
      deletedInAdmin: Boolean(r.deletedInAdmin),
    };
    if (r.reason === "orfao_sem_franquia") orphans.push({ ...record, eligible: r.orphanEligible, orphanReason: r.orphanReason });
    if (!isCandidate) {
      bump(excluded, r.reason);
      return;
    }
    candidates.push(record);
  }

  function finalize() {
    const order = (a, b) => byRank(a.primary, b.primary) || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0);
    candidates.sort(order);
    orphans.sort(order);

    const perScope = scopes.map((s) => ({ label: s.label, universe: s.universe, line: s.line, total: 0, p1: 0, p2: 0, apagados: 0, semStock: 0, loungefly: 0, loungeflyBase: 0, loungeflyExcecao: 0, orfaos: 0, orfaosElegiveis: 0 }));
    for (const c of candidates) {
      const ps = perScope[c.primary.scopeIndex];
      ps.total += 1;
      if (c.primary.priority === 1) ps.p1 += 1;
      else ps.p2 += 1;
      if (c.deletedInAdmin) ps.apagados += 1;
      if (!(c.stock > 0)) ps.semStock += 1;
      if (c.scope.loungefly) {
        ps.loungefly += 1;
        if (c.scope.base) ps.loungeflyBase += 1;
        else ps.loungeflyExcecao += 1;
      }
    }
    for (const o of orphans) {
      const ps = perScope[o.primary.scopeIndex];
      ps.orfaos += 1;
      if (o.eligible) ps.orfaosElegiveis += 1;
    }

    const names = [];
    for (const s of scopes) {
      for (const e of s.names) {
        const st = perName.get(e.key);
        names.push({
          key: e.key,
          scope: s.label,
          name: e.name,
          priority: e.priority,
          mode: e.mode,
          risk: e.risk,
          aliases: e.aliases,
          catalog: st.catalog,
          inUniverse: st.inUniverse,
          outUniverse: st.outUniverse,
          semUniverso: st.semUniverso,
          orphans: st.orphans,
          orphansEligible: st.orphansEligible,
          candidates: st.candidates,
          semFiltro: st.semFiltro,
          reasons: st.reasons,
          samples: e.risk ? buildSamples(st.matched) : null,
        });
      }
    }

    const total = candidates.length;
    const p1 = candidates.filter((c) => c.primary.priority === 1).length;
    const lf = candidates.filter((c) => c.scope.loungefly);
    return {
      rowsSeen,
      candidates,
      orphans,
      perScope,
      perName: names,
      excluded,
      sizeOnly: sizeOnly.slice().sort((a, b) => (a.sku < b.sku ? -1 : 1)),
      textileSamples: spread(textileSeen.slice().sort((a, b) => (a.sku < b.sku ? -1 : 1)), TEXTILE_SAMPLE_SIZE),
      b7Aliases: [...b7.values()].sort((a, b) => b.inUniverse - a.inUniverse || (a.alias < b.alias ? -1 : 1)),
      entryByKey,
      totals: {
        total,
        p1,
        p2: total - p1,
        semFiltro,
        soBase: candidates.filter((c) => c.scope.base).length,
        apagados: candidates.filter((c) => c.deletedInAdmin).length,
        orfaos: orphans.length,
        orfaosElegiveis: orphans.filter((o) => o.eligible).length,
        semStock: candidates.filter((c) => !(c.stock > 0)).length,
        loungefly: lf.length,
        loungeflyBase: lf.filter((c) => c.scope.base).length,
        loungeflyExcecao: lf.filter((c) => !c.scope.base).length,
        publishSeconds: Math.round(total * PUBLISH_SECONDS_PER_PRODUCT),
      },
      topExcludedVendors: [...outOfScopeVendors.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, TOP_EXCLUDED_VENDORS)
        .map(([vendor, count]) => ({ vendor, count })),
    };
  }

  return { addRow, finalize };
}

/** Amostra: candidatos primeiro; sem candidatos suficientes, qualquer correspondência. */
function buildSamples(matched) {
  const sorted = matched.slice().sort((a, b) => (a.sku < b.sku ? -1 : 1));
  const good = sorted.filter((m) => m.reason === null);
  const pool = good.length >= SAMPLE_SIZE ? good : [...good, ...sorted.filter((m) => m.reason !== null)];
  return spread(pool, SAMPLE_SIZE).map((m) => ({
    sku: m.sku,
    title: m.title,
    label: m.reason === null ? "candidato" : m.reason === "universo_errado" ? `universo errado (${m.universe ?? "?"})` : reasonLabel(m.reason),
  }));
}

/** "1 h 23 min" a partir de segundos. */
export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

/**
 * Guarda do execute: nenhum SKU a aprovar sem universo resolvido. Lança se houver um.
 * @param {Array<{ sku: string, resolvedFranchise: string|null }>} candidates
 */
export function assertAllHaveFranchise(candidates) {
  const sem = candidates.filter((c) => c.resolvedFranchise == null || String(c.resolvedFranchise).trim() === "");
  if (sem.length) throw new Error(`${sem.length} candidato(s) sem resolvedFranchise (ex.: ${sem.slice(0, 5).map((c) => c.sku).join(", ")}). Nada escrito.`);
}

// ───────────────────────── CSV ─────────────────────────

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const money = (n) => (Number.isFinite(n) ? n.toFixed(2) : "");

/** CSV dos candidatos: uma linha por SKU; `personagem` junta os nomes que bateram. */
export function buildApprovalCsv(result, scopes) {
  const lines = [CSV_COLUMNS.map(csvCell).join(",")];
  for (const c of result.candidates) {
    const ambito = c.scope.base ? (c.scope.loungefly ? "coleccionavel+loungefly" : "coleccionavel") : "loungefly";
    lines.push(
      [c.sku, c.title || "", scopes[c.primary.scopeIndex].label, c.matched.map((e) => e.name).join(" | "), money(c.cost), c.vendor, c.stock, `P${c.primary.priority}`, ambito, c.scope.loungefly ? c.scope.via : "", c.deletedInAdmin ? "sim" : ""]
        .map(csvCell)
        .join(",")
    );
  }
  return lines.join("\r\n") + "\r\n";
}

/** CSV dos órfãos da passagem B — fora do execute, para decisão à parte. */
export function buildOrphanCsv(result, scopes) {
  const lines = [ORPHAN_CSV_COLUMNS.map(csvCell).join(",")];
  for (const o of result.orphans) {
    lines.push(
      [o.sku, o.title || "", scopes[o.primary.scopeIndex].universe, o.matched.map((e) => e.name).join(" | "), money(o.cost), o.vendor, o.stock, o.eligible ? "sim" : "não", o.eligible ? "" : reasonLabel(o.orphanReason)]
        .map(csvCell)
        .join(",")
    );
  }
  return lines.join("\r\n") + "\r\n";
}

// ───────────────────────── Resumo ─────────────────────────

/**
 * Resumo em Markdown. Só contagens, nomes e títulos: sem custos (o log do fly-ops é
 * público; os custos ficam nos CSV em reports/, fora do git).
 */
export function buildApprovalSummary(result, { meta = {} } = {}) {
  const t = result.totals;
  const ex = result.excluded;
  const out = [];
  out.push(`# Aprovação por personagem — dry-run`);
  out.push("");
  for (const [k, v] of Object.entries(meta)) out.push(`- ${k}: ${v}`);
  out.push(`- linhas de catálogo lidas: ${result.rowsSeen}`);
  out.push("");
  out.push(`## Totais (um SKU conta uma vez)`);
  out.push("");
  out.push(`| Métrica | SKUs |`);
  out.push(`|---|---:|`);
  out.push(`| **Candidatos (com filtro de âmbito)** | **${t.total}** |`);
  out.push(`| P1 / P2 (pelo personagem de maior prioridade) | ${t.p1} / ${t.p2} |`);
  out.push(`| Sem filtro de âmbito | ${t.semFiltro} |`);
  out.push(`| Só filtro base (coleccionáveis, decisão 15/09) | ${t.soBase} |`);
  out.push(`| Filtro base + exceção Loungefly | ${t.total} |`);
  out.push(`| PENDING apagados no admin incluídos nos candidatos | ${t.apagados} |`);
  out.push(`| Candidatos sem stock (não filtra) | ${t.semStock} |`);
  out.push(`| Loungefly nos candidatos | ${t.loungefly} (passa no filtro base: ${t.loungeflyBase}; só pela exceção: ${t.loungeflyExcecao}) |`);
  out.push(`| Órfãos da passagem B, fora do execute (lista à parte) | ${t.orfaos} (passariam os outros filtros: ${t.orfaosElegiveis}) |`);
  out.push(`| Estimativa de publish (${PUBLISH_SECONDS_PER_PRODUCT} s/produto) | ${formatDuration(t.publishSeconds)} |`);
  out.push("");
  out.push(`## Excluídos (motivo, primeiro que se aplica)`);
  out.push("");
  out.push(`| Motivo | SKUs |`);
  out.push(`|---|---:|`);
  for (const r of ["universo_errado", "orfao_sem_franquia", "rejected", "fora_da_fila", "estado_approved", "estado_published", "estado_sync_error", "preco", "textil", "fora_ambito"]) {
    out.push(`| ${reasonLabel(r)} | ${ex[r] || 0} |`);
  }
  for (const [r, n] of Object.entries(ex)) if (!(r in REASON_LABELS)) out.push(`| ${r} | ${n} |`);
  out.push("");

  out.push(`## Têxtil — ${TEXTILE_SAMPLE_SIZE} títulos de amostra`);
  out.push("");
  if (!result.textileSamples.length) out.push(`- (nenhum)`);
  for (const s of result.textileSamples) out.push(`- ${s.sku} · ${s.title} _(${s.via})_`);
  out.push("");
  out.push(`## Regra do tamanho — lista completa (${result.sizeOnly.length})`);
  out.push("");
  if (!result.sizeOnly.length) out.push(`- (nenhum)`);
  for (const s of result.sizeOnly) out.push(`- ${s.sku} · ${s.title} _(${s.via})_`);
  out.push("");

  out.push(`## Por franquia`);
  out.push("");
  out.push(`| Franquia | Total | P1 | P2 | Apagados no admin | Sem stock | Loungefly | Loungefly via base (FUNKO) | Loungefly só pela exceção | Órfãos (fora) |`);
  out.push(`|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
  for (const s of result.perScope) {
    out.push(`| ${s.label} | ${s.total} | ${s.p1} | ${s.p2} | ${s.apagados} | ${s.semStock} | ${s.loungefly} | ${s.loungeflyBase} | ${s.loungeflyExcecao} | ${s.orfaos} |`);
  }
  out.push("");

  for (const pr of [1, 2]) {
    out.push(`## Por personagem — P${pr}`);
    out.push("");
    out.push(`| Franquia | Personagem | Modo | No catálogo | No universo | Órfãos (fora) | Órfãos elegíveis | Fora do universo | Sem universo | Sem filtro | Candidatos |`);
    out.push(`|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|`);
    for (const n of result.perName.filter((x) => x.priority === pr)) {
      out.push(`| ${n.scope} | ${n.name} | ${n.mode} | ${n.catalog} | ${n.inUniverse} | ${n.orphans} | ${n.orphansEligible} | ${n.outUniverse} | ${n.semUniverso} | ${n.semFiltro} | ${n.candidates} |`);
    }
    out.push("");
  }

  const zeros = result.perName.filter((n) => n.candidates === 0);
  out.push(`## Personagens com zero candidatos (${zeros.length} de ${result.perName.length})`);
  out.push("");
  if (zeros.length) {
    out.push(`| Franquia | Personagem | Pri | No catálogo | No universo | Motivos |`);
    out.push(`|---|---|---|---:|---:|---|`);
    for (const n of zeros) {
      const motivos = Object.entries(n.reasons)
        .sort((a, b) => b[1] - a[1])
        .map(([r, c]) => `${reasonLabel(r)}: ${c}`)
        .join("; ");
      out.push(`| ${n.scope} | ${n.name} | P${n.priority} | ${n.catalog} | ${n.inUniverse} | ${motivos || (n.catalog ? "só fora do universo" : "sem correspondência")} |`);
    }
  } else out.push(`Nenhum.`);
  out.push("");

  out.push(`## Aliases do B7 fora do briefing`);
  out.push("");
  out.push(`Correspondências no universo feitas por aliases do vocabulário B7 que não estão na lista nem no briefing. "Só por este alias" = candidatos que saíam se o alias fosse tirado.`);
  out.push("");
  out.push(`| Franquia | Personagem | Alias B7 | No universo | Candidatos | Só por este alias |`);
  out.push(`|---|---|---|---:|---:|---:|`);
  for (const b of result.b7Aliases) out.push(`| ${b.scope} | ${b.name} | ${b.alias} | ${b.inUniverse} | ${b.candidates} | ${b.onlyVia} |`);
  if (!result.b7Aliases.length) out.push(`| (nenhuma) | | | 0 | 0 | 0 |`);
  out.push("");

  out.push(`## Órfãos da passagem B — fora do execute`);
  out.push("");
  out.push(`Nada grava resolvedFranchise pela via do personagem (o B7 só aplica a passagem A). Estes SKUs não entram: chegavam à loja sem alterpop.franchise. Lista completa no CSV de órfãos.`);
  out.push("");
  out.push(`| Franquia do personagem | Órfãos | Passariam os outros filtros |`);
  out.push(`|---|---:|---:|`);
  for (const s of result.perScope.filter((x) => x.orfaos)) out.push(`| ${s.label} | ${s.orfaos} | ${s.orfaosElegiveis} |`);
  if (!result.orphans.length) out.push(`| (nenhum) | 0 | 0 |`);
  out.push("");

  out.push(`## Top ${TOP_EXCLUDED_VENDORS} fabricantes excluídos pelo filtro de âmbito`);
  out.push("");
  out.push(`SKUs que passam universo, estado e preço, e caem só no filtro. Para o Carlos acrescentar exceções.`);
  out.push("");
  out.push(`| Fabricante | SKUs |`);
  out.push(`|---|---:|`);
  for (const v of result.topExcludedVendors) out.push(`| ${v.vendor} | ${v.count} |`);
  if (!result.topExcludedVendors.length) out.push(`| (nenhum) | 0 |`);
  out.push("");

  out.push(`## Nomes de risco — contagem e ${SAMPLE_SIZE} títulos de amostra`);
  out.push("");
  for (const n of result.perName.filter((x) => x.risk)) {
    out.push(`### ${n.name} — ${n.scope}`);
    out.push(`candidatos ${n.candidates} · no universo ${n.inUniverse} · fora do universo ${n.outUniverse} · no catálogo ${n.catalog}`);
    if (!n.samples.length) out.push(`- (sem correspondências)`);
    for (const s of n.samples) out.push(`- ${s.sku} · ${s.title} _(${s.label})_`);
    out.push("");
  }
  return out.join("\n");
}

/**
 * Linhas de log (bloqueador 3): contagem por personagem com P1 e P2 separados, órfãos
 * por personagem, têxtil com amostra e, para DETAIL_SCOPES, o motivo por personagem.
 * Só nomes, títulos e contagens: nunca custos (o log das Actions é público).
 * @returns {string[]}
 */
export function buildLogTables(result) {
  const out = [];
  const pad = (v, n) => String(v).padStart(n);
  out.push(`têxtil excluído: ${result.excluded.textil || 0} (amostra de ${TEXTILE_SAMPLE_SIZE}):`);
  for (const s of result.textileSamples) out.push(`      ${s.sku} · ${s.title} (${s.via})`);
  out.push("");
  out.push(`regra do tamanho — excluídos só pelo tamanho no fim, sem palavra de têxtil (lista completa): ${result.sizeOnly.length}`);
  for (const s of result.sizeOnly) out.push(`      ${s.sku} · ${s.title} (${s.via})`);
  for (const pr of [1, 2]) {
    out.push("");
    out.push(`por personagem — P${pr} (no universo · candidatos):`);
    for (const n of result.perName.filter((x) => x.priority === pr)) out.push(`  ${n.scope} · ${n.name}: ${pad(n.inUniverse, 5)} · ${pad(n.candidates, 5)}`);
  }
  out.push("");
  out.push(`órfãos por personagem (fora do execute · passariam os outros filtros):`);
  const orf = result.perName.filter((n) => n.orphans > 0);
  for (const n of orf) out.push(`  ${n.scope} · ${n.name}: ${pad(n.orphans, 5)} · ${pad(n.orphansEligible, 5)}`);
  if (!orf.length) out.push(`  (nenhum)`);
  for (const label of DETAIL_SCOPES) {
    out.push("");
    out.push(`detalhe ${label} (no catálogo · candidatos · âmbito · preço · têxtil · universo errado · sem universo · outros):`);
    for (const n of result.perName.filter((x) => x.scope === label)) {
      const rs = n.reasons;
      const known = (rs.candidato || 0) + (rs.fora_ambito || 0) + (rs.preco || 0) + (rs.textil || 0);
      const outros = n.inUniverse + n.orphans - known;
      out.push(`  ${n.name}: ${n.catalog} · ${n.candidates} · ${rs.fora_ambito || 0} · ${rs.preco || 0} · ${rs.textil || 0} · ${n.outUniverse} · ${n.semUniverso} · ${outros}`);
    }
  }
  return out;
}

// ───────────────────────── escrita e reversão ─────────────────────────

const PREVIOUS_FIELDS = ["approvedAt", "rejectedAt", "origem"];

/**
 * Aplica a aprovação sobre a fila já lida DENTRO do lock. Revalida cada SKU: só
 * PENDING (um apagado no admin entra, e mantém a marca deletedInAdmin). Guarda o
 * estado anterior em metadata.importPrevious para a reversão. Idempotente: um SKU já
 * marcado com esta origem não volta a ser escrito. Muta `fila.items` no lugar.
 * @param {{ items: object[] }} fila
 * @param {string[]} skus
 * @param {{ origin: string, now?: string }} opts
 */
export function applyApproval(fila, skus, { origin, now = new Date().toISOString() }) {
  if (!origin) throw new Error("applyApproval: origem em falta");
  const index = new Map(fila.items.map((i) => [i.sku, i]));
  const approved = [];
  const already = [];
  const dropped = [];
  for (const sku of unique(skus)) {
    const item = index.get(sku);
    if (!item) {
      dropped.push({ sku, reason: "fora da fila" });
      continue;
    }
    if (item.metadata?.[META_ORIGIN] === origin && item.status !== "PENDING") {
      already.push({ sku, status: item.status });
      continue;
    }
    if (item.status !== "PENDING") {
      dropped.push({ sku, reason: `estado ${item.status}` });
      continue;
    }
    const meta = item.metadata || {};
    const previous = { status: item.status, shopifyStatus: item.shopifyStatus ?? null, statusChangedAt: item.statusChangedAt ?? null };
    for (const f of PREVIOUS_FIELDS) previous[f] = f in meta ? meta[f] : null;
    const clean = { ...meta };
    delete clean.despublicadoEm;
    delete clean.descontinuadoIgnoradoEm;
    item.status = "APPROVED";
    item.statusChangedAt = now;
    item.shopifyStatus = "ACTIVE";
    // origem fica "humano": é o valor que congela a decisão contra o worker e as regras
    // de painel (origemCongelada). A marca desta corrida vai em importOrigin.
    item.metadata = { ...clean, approvedAt: now, rejectedAt: null, origem: "humano", [META_ORIGIN]: origin, [META_PREVIOUS]: previous };
    approved.push(sku);
  }
  return { approved, already, dropped };
}

/**
 * Reverte o que `applyApproval` escreveu com esta origem. Só APPROVED volta ao estado
 * anterior; PUBLISHED, SYNC_ERROR e itens com shopifyProductId ficam e são reportados —
 * o revert não despublica nada na loja. Muta `fila.items` no lugar.
 * @param {{ items: object[] }} fila
 * @param {{ origin: string }} opts
 */
export function revertApproval(fila, { origin }) {
  if (!origin) throw new Error("revertApproval: origem em falta");
  const reverted = [];
  const kept = [];
  for (const item of fila.items) {
    const meta = item.metadata || {};
    if (meta[META_ORIGIN] !== origin) continue;
    if (item.status !== "APPROVED") {
      kept.push({ sku: item.sku, status: item.status, reason: item.status === "PUBLISHED" ? "já publicado (despublicar é do Carlos)" : `estado ${item.status}` });
      continue;
    }
    if (meta.shopifyProductId) {
      kept.push({ sku: item.sku, status: item.status, reason: "tem shopifyProductId" });
      continue;
    }
    const prev = meta[META_PREVIOUS] || {};
    const next = { ...meta };
    delete next[META_ORIGIN];
    delete next[META_PREVIOUS];
    for (const f of PREVIOUS_FIELDS) {
      if (prev[f] == null) delete next[f];
      else next[f] = prev[f];
    }
    item.status = prev.status || "PENDING";
    item.shopifyStatus = prev.shopifyStatus ?? "DRAFT";
    if (prev.statusChangedAt == null) delete item.statusChangedAt;
    else item.statusChangedAt = prev.statusChangedAt;
    item.metadata = next;
    reverted.push(item.sku);
  }
  return { reverted, kept };
}
