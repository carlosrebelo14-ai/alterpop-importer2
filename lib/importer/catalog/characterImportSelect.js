/**
 * Importação por personagem (briefing backend 09/10/2026) — lógica pura de seleção, CSV
 * e planeamento da aprovação. Sem Prisma, sem Shopify, sem escrita: o script
 * scripts/catalog/character-import.js trata do I/O e chama isto. Tudo o que decide qual
 * produto entra no lote vive aqui, para ficar coberto por teste
 * (scripts/tests/character-import.test.js).
 *
 * Fluxo de dados: o script lê o CatalogProduct por cursor e entrega cada linha a
 * `collector.addRow` (nada fica em memória além das linhas que batem num nome);
 * `collector.finalize()` escolhe, por personagem, até ao teto.
 *
 * Correspondência — nome ou alias no cleanTitle, palavra inteira, sem distinção de
 * maiúsculas nem de acentos, em NFC. Pontuação e hífens valem como espaço
 * ("Obi-Wan" = "Obi Wan", "Monkey.D.Luffy" = "Monkey D Luffy"), e a fronteira é a
 * palavra inteira de ambos os lados ("Rex" não bate em "Rexy"; "Max" não bate em
 * "Maximus").
 */
import { parse as parseCsv } from "csv-parse/sync";
import { CHARACTER_ALIASES } from "./characterVocabulary.js";
import { FRANCHISE_UNIVERSES } from "./franchiseUniverses.js";
import { FRANCHISE_LINES } from "./franchiseLines.js";
import { resolveManufacturerTier, isCollectibleVendor } from "./manufacturerTierResolver.server.js";
import { priceRow } from "../pricing/pricing.server.js";

export const DEFAULT_CAP_P1 = 2;
export const DEFAULT_CAP_P2 = 1;
/** Suplentes por personagem, abaixo do teto, para o Carlos trocar sem nova corrida. */
export const SUBSTITUTES_PER_NAME = 3;
export const SAMPLE_SIZE = 5;

/** Cabeçalho do CSV de candidatos — o do briefing, mais `nota` (avisos que não são B18). */
export const CSV_COLUMNS = [
  "universo",
  "line",
  "personagem",
  "prioridade",
  "modo",
  "SKU",
  "cleanTitle",
  "fabricante",
  "tier",
  "formato",
  "custo_sem_iva",
  "custo_com_iva_es",
  "margem",
  "preço final",
  "stock",
  "URL da imagem",
  "avisos B18",
  "nota",
  "aprovar",
];

const nfc = (s) => (s == null ? s : String(s).normalize("NFC"));

/**
 * Forma de comparação: NFC → sem acentos → minúsculas → tudo o que não é letra/dígito
 * vira um espaço. Aplicada ao título e ao nome/alias, dos dois lados.
 * @param {unknown} value
 */
export function normalizeForMatch(value) {
  return String(value ?? "")
    .normalize("NFC")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** true se `phrase` (já normalizada) aparece em `title` como palavra(s) inteira(s). */
export function titleHasPhrase(title, phrase) {
  const p = normalizeForMatch(phrase);
  if (!p) return false;
  return ` ${normalizeForMatch(title)} `.includes(` ${p} `);
}

const unique = (list) => [...new Set(list)];

/**
 * Constrói os âmbitos (uma linha da tabela do Carlos = um âmbito) a partir do ficheiro
 * de dados. Os aliases do vocabulário B7 juntam-se quando o nome é igual; os do ficheiro
 * acrescentam-se por cima.
 * @param {object} data conteúdo de character-import-2026-10-09.json
 * @param {{ vocabAliases?: Record<string,string[]> }} [opts]
 */
export function buildScopes(data, { vocabAliases = CHARACTER_ALIASES } = {}) {
  return data.universes.map((row, scopeIndex) => {
    const universe = nfc(row.universe);
    const line = row.line || null;
    const handle = scopeHandleOf({ universe, line });
    const names = row.characters.map((c, nameIndex) => {
      const aliases = unique([c.name, ...(vocabAliases[c.name] || []), ...(c.aliases || [])]);
      return {
        key: `${scopeIndex}:${nameIndex}`,
        scopeIndex,
        nameIndex,
        name: c.name,
        priority: c.priority,
        mode: c.mode === "A+B" ? "A+B" : "A",
        eponym: Boolean(c.eponym),
        sample: Boolean(c.sample),
        aliases,
        phrases: unique(aliases.map(normalizeForMatch).filter(Boolean)),
      };
    });
    return {
      index: scopeIndex,
      universe,
      line,
      excludeLines: row.excludeLines || [],
      handle,
      label: line ? `${universe} / ${line}` : universe,
      names,
    };
  });
}

/** Handle do âmbito de uma linha do ficheiro de dados (ou do CSV): o da Line quando há,
 *  senão o do universo. */
export function scopeHandleOf({ universo, universe, line }) {
  const name = nfc(universo ?? universe);
  if (line) return FRANCHISE_LINES.find((l) => l.line === line)?.handle ?? null;
  return FRANCHISE_UNIVERSES.find((u) => nfc(u.name) === name)?.handle ?? null;
}

/** Ficheiro de dados reduzido às linhas de um âmbito (`--only-universe`). Filtrar ANTES
 *  de buildScopes mantém os índices dos âmbitos consecutivos. */
export function filterDataByHandle(data, handle) {
  if (!handle) return data;
  return { ...data, universes: data.universes.filter((u) => scopeHandleOf(u) === handle) };
}

/** O produto pertence ao universo (e à Line, quando a linha da tabela a exige). */
export function rowInScope(row, scope) {
  if (nfc(row.resolvedFranchise) !== scope.universe) return false;
  if (scope.line) return row.resolvedLine === scope.line;
  return !scope.excludeLines.includes(row.resolvedLine);
}

const isOrphan = (row) => row.resolvedFranchise == null || String(row.resolvedFranchise).trim() === "";

const TIER_RANK = { COLLECTOR: 0, CORE: 1 };
const tierRank = (tier) => (tier in TIER_RANK ? TIER_RANK[tier] : 2);

/**
 * Desempate (proposta do arquiteto): passagem A antes da B, COLLECTOR antes de CORE,
 * depois sem tier, maior stock, SKU. Devolve < 0 quando `a` vem primeiro.
 */
export function compareCandidates(a, b) {
  if (a.source !== b.source) return a.source === "A" ? -1 : 1;
  const t = tierRank(a.tier) - tierRank(b.tier);
  if (t) return t;
  if (a.stock !== b.stock) return b.stock - a.stock;
  return a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0;
}

/**
 * Elegibilidade de uma linha do catálogo para o lote. Devolve o PRIMEIRO motivo que a
 * tira (ordem fixa, para o resumo ser estável) ou `reason: null` com o preço calculado.
 * @param {object} row linha de CatalogProduct
 * @param {{ queueBySku: Map<string, {status: string, queueItem?: object, overridePrice?: number|null}>, globalMarginPct: number }} ctx
 */
export function evaluateRow(row, ctx) {
  const q = ctx.queueBySku.get(row.sku);
  if (!q) return { reason: "fora_da_fila" };
  if (q.status !== "PENDING") return { reason: `estado_${String(q.status).toLowerCase()}` };
  if (!(Number(row.stock) > 0)) return { reason: "sem_stock" };
  if (!isCollectibleVendor(row.vendor)) return { reason: "fora_coleccionaveis" };
  if (!String(row.imageUrl || "").trim()) return { reason: "sem_imagem" };
  if (!(Number(row.distributorPrice) > 0)) return { reason: "sem_custo" };
  const p = priceRow(row.distributorPrice, row.grossPrice, ctx.globalMarginPct, q.queueItem || null);
  if (p.priceError || p.finalPrice == null) return { reason: "preco_nao_calculavel", detail: p.priceError };
  return {
    reason: null,
    tier: resolveManufacturerTier(row.vendor),
    cost: p.cost,
    costNoVat: Number(row.distributorPrice),
    marginPct: p.marginPct,
    calcPrice: p.finalPrice,
    priceStatus: p.priceStatus,
    overridePrice: q.overridePrice ?? null,
    deletedAt: q.deletedAt ?? null,
  };
}

/** Legendas legíveis dos motivos (resumo e zero candidatos). */
export const REASON_LABELS = {
  sem_correspondencia: "sem correspondência",
  fora_da_fila: "fora da fila de curadoria",
  sem_stock: "sem stock",
  fora_coleccionaveis: "fora de coleccionáveis",
  sem_imagem: "sem imagem",
  sem_custo: "sem custo",
  preco_nao_calculavel: "preço não calculável",
  eponimo_bate_noutro_nome: "epónimo: bate noutro nome do universo",
  estado_published: "já publicado",
  estado_approved: "já aprovado",
  estado_rejected: "rejeitado",
  estado_sync_error: "em SYNC_ERROR",
};
const reasonLabel = (r) => REASON_LABELS[r] || r;

function spread(list, n) {
  if (list.length <= n) return list.slice();
  const out = [];
  for (let i = 0; i < n; i++) out.push(list[Math.floor((i * list.length) / n)]);
  return out;
}

function bump(map, key) {
  map[key] = (map[key] || 0) + 1;
}

/**
 * Escolha dentro de um personagem: ordem de ranking, mas os lugares de P1 preferem
 * formatos (`resolvedFormat`) diferentes — o segundo lugar não repete o formato do
 * primeiro (nem o de um já publicado) se houver alternativa. A preferência só olha
 * para candidatos da mesma passagem do melhor que sobra (um órfão nunca passa à frente
 * de um candidato A só por ter formato diferente).
 */
function pickSlots(ranked, slots, usedFormats, wantVariety) {
  const picks = [];
  const remaining = ranked.slice();
  while (picks.length < slots && remaining.length) {
    let idx = 0;
    if (wantVariety) {
      const lead = remaining[0].source;
      const alt = remaining.findIndex((c) => c.source === lead && !usedFormats.has(c.format ?? "∅"));
      if (alt >= 0) idx = alt;
    }
    const [chosen] = remaining.splice(idx, 1);
    picks.push(chosen);
    usedFormats.add(chosen.format ?? "∅");
  }
  return { picks, remaining };
}

/**
 * Colector em streaming. `addRow` vê cada linha do catálogo uma vez; só retém as que
 * batem em algum nome (candidatas, comprometidas, amostras).
 * @param {{
 *   scopes: ReturnType<typeof buildScopes>,
 *   queueBySku: Map<string, object>,
 *   globalMarginPct: number,
 *   capP1?: number, capP2?: number,
 * }} opts
 */
export function createCollector({ scopes, queueBySku, globalMarginPct, capP1: defaultCapP1 = DEFAULT_CAP_P1, capP2: defaultCapP2 = DEFAULT_CAP_P2 }) {
  const ctx = { queueBySku, globalMarginPct };
  const entries = scopes.flatMap((s) => s.names);
  const needles = new Map(); // " frase " -> entries[]
  for (const e of entries) {
    for (const p of e.phrases) {
      const needle = ` ${p} `;
      if (!needles.has(needle)) needles.set(needle, []);
      needles.get(needle).push(e);
    }
  }
  const needleList = [...needles.keys()];

  const state = new Map(
    entries.map((e) => [
      e.key,
      {
        totalCatalog: 0,
        dentro: 0,
        orfaos: 0,
        candidates: [],
        committed: [],
        reasons: {},
        matched: [], // só para nomes com amostra obrigatória
      },
    ])
  );
  let rowsSeen = 0;

  function addRow(row) {
    rowsSeen += 1;
    const haystack = ` ${normalizeForMatch(row.cleanTitle || row.title)} `;
    /** @type {Map<string, object>} */
    const hit = new Map();
    for (const needle of needleList) {
      if (!haystack.includes(needle)) continue;
      for (const e of needles.get(needle)) hit.set(e.key, e);
    }
    if (!hit.size) return;

    const perScope = new Map();
    for (const e of hit.values()) perScope.set(e.scopeIndex, (perScope.get(e.scopeIndex) || 0) + 1);

    let ev = null;
    const evaluate = () => (ev ??= evaluateRow(row, ctx));

    for (const e of hit.values()) {
      const st = state.get(e.key);
      st.totalCatalog += 1;
      const scope = scopes[e.scopeIndex];
      const inA = rowInScope(row, scope);
      const inB = !inA && e.mode === "A+B" && !scope.line && isOrphan(row);
      if (!inA && !inB) continue;
      if (inA) st.dentro += 1;
      else st.orfaos += 1;

      const record = (reason) => {
        if (reason) bump(st.reasons, reason);
        if (e.sample) st.matched.push({ sku: row.sku, title: row.cleanTitle || row.title, reason });
      };

      // Epónimo: só produtos que não batem noutro nome do mesmo universo.
      if (e.eponym && perScope.get(e.scopeIndex) > 1) {
        record("eponimo_bate_noutro_nome");
        continue;
      }

      const q = queueBySku.get(row.sku);
      if (q && (q.status === "PUBLISHED" || q.status === "APPROVED")) {
        st.committed.push({ sku: row.sku, format: row.resolvedFormat ?? null, status: q.status, title: row.cleanTitle || row.title });
        record(`estado_${q.status.toLowerCase()}`);
        continue;
      }

      const r = evaluate();
      if (r.reason) {
        record(r.reason);
        continue;
      }
      record(null);
      st.candidates.push({
        sku: row.sku,
        source: inA ? "A" : "B",
        tier: r.tier,
        stock: Number(row.stock),
        format: row.resolvedFormat ?? null,
        ev: r,
        row,
      });
    }
  }

  /**
   * Escolhe por personagem. Pode ser chamado várias vezes sobre o mesmo estado (teto e
   * sem teto lado a lado): não muda nada do que `addRow` recolheu. Teto 0 = sem teto.
   * @param {{ capP1?: number, capP2?: number }} [caps]
   */
  function finalize({ capP1 = defaultCapP1, capP2 = defaultCapP2 } = {}) {
    const resolveCap = (n) => (n === 0 ? Infinity : n);
    const processing = entries
      .slice()
      .sort((a, b) => Number(a.eponym) - Number(b.eponym) || a.priority - b.priority || a.scopeIndex - b.scopeIndex || a.nameIndex - b.nameIndex);

    const claimed = new Set(); // SKUs já escolhidos/comprometidos por um nome anterior
    const result = new Map();

    // 1.ª passagem: comprometidos (publicados/aprovados) e escolhidos, por ordem de processamento.
    for (const e of processing) {
      const st = state.get(e.key);
      const own = st.committed.filter((c) => !claimed.has(c.sku));
      own.forEach((c) => claimed.add(c.sku));
      const cap = resolveCap(e.priority === 1 ? capP1 : capP2);
      const slots = Math.max(0, cap - own.length);
      const usedFormats = new Set(own.map((c) => c.format ?? "∅"));
      const available = st.candidates.filter((c) => !claimed.has(c.sku)).sort(compareCandidates);
      const { picks, remaining } = pickSlots(available, slots, usedFormats, e.priority === 1);
      picks.forEach((c) => claimed.add(c.sku));
      result.set(e.key, {
        cap,
        committedOwn: own.length,
        picks,
        remaining,
        lostToOthers: st.candidates.length - available.length,
        substitutes: [],
      });
    }

    // 2.ª passagem: suplentes — próximos do ranking, sem repetir SKU entre nomes.
    for (const e of processing) {
      const res = result.get(e.key);
      const subs = [];
      for (const c of res.remaining) {
        if (subs.length >= SUBSTITUTES_PER_NAME) break;
        if (claimed.has(c.sku)) continue;
        subs.push(c);
        claimed.add(c.sku);
      }
      res.substitutes = subs;
    }

    // Saída na ordem do ficheiro de dados.
    const rows = [];
    const perName = [];
    for (const scope of scopes) {
      for (const e of scope.names) {
        const st = state.get(e.key);
        const res = result.get(e.key);
        for (const c of res.picks) rows.push({ scope, entry: e, kind: "escolhido", cand: c });
        for (const c of res.substitutes) rows.push({ scope, entry: e, kind: "suplente", cand: c });

        const candidatos = st.candidates.length;
        let zero = null;
        if (res.picks.length === 0) {
          if (st.dentro + st.orfaos === 0) zero = reasonLabel("sem_correspondencia");
          else if (res.cap !== Infinity && res.committedOwn >= res.cap) zero = `teto cheio (${res.committedOwn} já publicado/aprovado)`;
          else if (candidatos === 0) {
            const parts = Object.entries(st.reasons)
              .sort((a, b) => b[1] - a[1])
              .map(([r, n]) => `${reasonLabel(r)}: ${n}`);
            zero = parts.join("; ") || reasonLabel("sem_correspondencia");
          } else zero = "candidatos já escolhidos por outro nome";
        }
        perName.push({
          key: e.key,
          scope: scope.label,
          handle: scope.handle,
          universe: scope.universe,
          line: scope.line,
          name: e.name,
          priority: e.priority,
          mode: e.mode,
          eponym: e.eponym,
          sample: e.sample,
          totalCatalog: st.totalCatalog,
          dentro: st.dentro,
          orfaos: st.orfaos,
          orfaosElegiveis: st.candidates.filter((c) => c.source === "B").length,
          candidatos,
          comprometidos: res.committedOwn,
          escolhidos: res.picks.length,
          suplentes: res.substitutes.length,
          cap: res.cap === Infinity ? null : res.cap,
          reasons: st.reasons,
          zero,
          samples: e.sample ? buildSamples(st) : null,
        });
      }
    }

    const perScope = scopes.map((scope) => {
      const names = perName.filter((n) => n.scope === scope.label);
      const uni = FRANCHISE_UNIVERSES.find((u) => nfc(u.name) === scope.universe);
      return {
        label: scope.label,
        handle: scope.handle,
        universe: scope.universe,
        line: scope.line,
        tableStatus: uni?.status ?? null,
        dormant: Boolean(uni?.dormant),
        escolhidos: names.reduce((s, n) => s + n.escolhidos, 0),
        comprometidos: names.reduce((s, n) => s + n.comprometidos, 0),
        candidatos: names.reduce((s, n) => s + n.candidatos, 0),
      };
    });

    // Já publicados/aprovados que bateram em algum nome — contexto do TITLE_DUPLICATE (B18).
    const committed = new Map();
    for (const st of state.values()) for (const c of st.committed) committed.set(c.sku, { sku: c.sku, title: c.title });

    return {
      rows,
      perName,
      perScope,
      committed: [...committed.values()],
      totals: {
        rowsSeen,
        escolhidos: rows.filter((r) => r.kind === "escolhido").length,
        suplentes: rows.filter((r) => r.kind === "suplente").length,
      },
    };
  }

  return { addRow, finalize };
}

function buildSamples(st) {
  const good = st.matched.filter((m) => !m.reason).sort((a, b) => (a.sku < b.sku ? -1 : 1));
  if (good.length) return spread(good, SAMPLE_SIZE).map((m) => ({ ...m, label: "candidato" }));
  const any = st.matched.slice().sort((a, b) => (a.sku < b.sku ? -1 : 1));
  return spread(any, SAMPLE_SIZE).map((m) => ({ ...m, label: reasonLabel(m.reason) }));
}

// ───────────────────────── CSV ─────────────────────────

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const money = (n) => (Number.isFinite(n) ? n.toFixed(2) : "");

/**
 * Linhas do CSV: `aprovar = sim` nos escolhidos, vazia nos suplentes; avisos B18 por SKU
 * vêm de `warningsBySku` (Map sku → string[] de códigos).
 * @param {ReturnType<ReturnType<typeof createCollector>['finalize']>['rows']} rows
 * @param {{ warningsBySku?: Map<string,string[]> }} [opts]
 */
export function buildCsv(rows, { warningsBySku = new Map() } = {}) {
  const lines = [CSV_COLUMNS.map(csvCell).join(",")];
  for (const { scope, entry, kind, cand } of rows) {
    const { row, ev } = cand;
    const price = ev.overridePrice != null ? ev.overridePrice : ev.calcPrice;
    const notes = [];
    if (kind === "suplente") notes.push("suplente");
    if (cand.source === "B") notes.push("órfão (passagem B): sem universo resolvido, publica sem alterpop.franchise");
    if (ev.deletedAt) notes.push(`apagado no admin em ${String(ev.deletedAt).slice(0, 10)}`);
    if (ev.overridePrice != null) notes.push(`preço manual ${money(ev.overridePrice)} (calculado ${money(ev.calcPrice)})`);
    else if (ev.priceStatus && ev.priceStatus !== "MARGEM") notes.push(`preço: ${ev.priceStatus}`);
    lines.push(
      [
        scope.universe,
        scope.line || "",
        entry.name,
        entry.priority === 1 ? "P1" : "P2",
        entry.mode,
        row.sku,
        row.cleanTitle || row.title || "",
        row.vendor || "",
        ev.tier || "",
        row.resolvedFormat || "",
        money(ev.costNoVat),
        money(ev.cost),
        ev.marginPct ?? "",
        money(price),
        row.stock,
        row.imageUrl || "",
        (warningsBySku.get(row.sku) || []).join(" "),
        notes.join("; "),
        kind === "escolhido" && cand.source === "A" ? "sim" : "",
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return lines.join("\r\n") + "\r\n";
}

const headerKey = (h) => normalizeForMatch(h).replace(/ /g, "");

/**
 * Lê o CSV que o Carlos reviu. Só precisa de `SKU` e `aprovar`; `universo`/`line`
 * servem ao filtro --only-universe. Cabeçalhos comparados sem acentos nem maiúsculas.
 * @returns {Array<{ sku: string, aprovar: string, universo: string, line: string, personagem: string, price: number|null }>}
 */
export function parseApprovalCsv(text) {
  const records = parseCsv(String(text).replace(/^﻿/, ""), { columns: (h) => h.map(headerKey), skip_empty_lines: true, trim: true });
  if (!records.length) return [];
  const first = records[0];
  for (const required of ["sku", "aprovar"]) {
    if (!(required in first)) throw new Error(`CSV sem a coluna "${required === "sku" ? "SKU" : "aprovar"}"`);
  }
  return records.map((r) => ({
    sku: String(r.sku || "").trim(),
    aprovar: String(r.aprovar || "").trim().toLowerCase(),
    universo: nfc(String(r.universo || "").trim()),
    line: String(r.line || "").trim(),
    personagem: String(r.personagem || "").trim(),
    price: Number.isFinite(Number(r.precofinal)) && r.precofinal !== "" ? Number(r.precofinal) : null,
  }));
}

/**
 * Plano da aprovação (`--execute --from-csv`). Nunca recalcula a seleção: aprova
 * exatamente as linhas `aprovar = sim`, depois de revalidar cada SKU contra o estado de
 * agora. Idempotente — SKUs que já estão APPROVED/PUBLISHED ficam em `alreadyDone` e não
 * geram escrita, por isso a segunda corrida do mesmo CSV não altera nada.
 * @param {ReturnType<typeof parseApprovalCsv>} csvRows
 * @param {Map<string, { status: string|null, stock: number|null, imageUrl: string|null, distributorPrice: number|null, inCatalog: boolean }>} currentBySku
 * @param {{ onlyHandle?: string|null }} [opts]
 */
export function planApproval(csvRows, currentBySku, { onlyHandle = null } = {}) {
  const toApprove = [];
  const alreadyDone = [];
  const dropped = [];
  let notMarked = 0;
  let outOfScope = 0;
  const seen = new Set();
  for (const r of csvRows) {
    if (r.aprovar !== "sim") {
      notMarked += 1;
      continue;
    }
    if (onlyHandle && scopeHandleOf(r) !== onlyHandle) {
      outOfScope += 1;
      continue;
    }
    if (!r.sku) {
      dropped.push({ sku: "", reason: "linha sem SKU" });
      continue;
    }
    if (seen.has(r.sku)) continue;
    seen.add(r.sku);
    const cur = currentBySku.get(r.sku);
    if (!cur || !cur.status) dropped.push({ sku: r.sku, reason: "SKU já não está na fila" });
    else if (cur.status === "APPROVED" || cur.status === "PUBLISHED") alreadyDone.push({ sku: r.sku, status: cur.status });
    else if (cur.status !== "PENDING") dropped.push({ sku: r.sku, reason: `estado ${cur.status} (já não está PENDING)` });
    else if (!cur.inCatalog) dropped.push({ sku: r.sku, reason: "SKU ausente do catálogo indexado" });
    else if (!(Number(cur.stock) > 0)) dropped.push({ sku: r.sku, reason: "sem stock no feed de agora" });
    else if (!String(cur.imageUrl || "").trim()) dropped.push({ sku: r.sku, reason: "sem imagem" });
    else if (!(Number(cur.distributorPrice) > 0)) dropped.push({ sku: r.sku, reason: "sem custo" });
    else toApprove.push(r.sku);
  }
  return { toApprove, alreadyDone, dropped, notMarked, outOfScope };
}

// ───────────────────────── Resumo ─────────────────────────

const pad = (s, n) => String(s).padEnd(n);

/**
 * Resumo do dry-run em Markdown: por universo, por nome (com e sem teto lado a lado),
 * passagem B, nomes sem escolhidos com o motivo, amostras.
 * @param {ReturnType<ReturnType<typeof createCollector>['finalize']>} result seleção com teto
 * @param {{ uncapped?: typeof result, collectionStates?: Map<string,string>, meta?: Record<string, unknown> }} [opts]
 */
export function buildSummaryMarkdown(result, { uncapped = null, collectionStates = new Map(), meta = {} } = {}) {
  const out = [];
  const uncappedName = new Map((uncapped?.perName || []).map((n) => [n.key, n]));
  const uncappedScope = new Map((uncapped?.perScope || []).map((s) => [s.label, s]));
  const semTeto = (n) => (uncapped ? uncappedName.get(n.key)?.escolhidos ?? "?" : "—");
  out.push(`# Importação por personagem — dry-run`);
  out.push("");
  for (const [k, v] of Object.entries(meta)) out.push(`- ${k}: ${v}`);
  out.push(`- linhas de catálogo lidas: ${result.totals.rowsSeen}`);
  out.push(`- escolhidos com teto: **${result.totals.escolhidos}** · suplentes: ${result.totals.suplentes}`);
  if (uncapped) out.push(`- escolhidos sem teto: **${uncapped.totals.escolhidos}**`);
  out.push("");

  out.push(`## Por universo`);
  out.push("");
  out.push(`| Âmbito | Handle | Escolhidos com teto | Escolhidos sem teto | Já publicados/aprovados | Candidatos | Estado na tabela | Coleção na loja |`);
  out.push(`|---|---|---:|---:|---:|---:|---|---|`);
  for (const s of result.perScope) {
    const table = s.dormant ? "dormente" : s.tableStatus || "?";
    const u = uncapped ? uncappedScope.get(s.label)?.escolhidos ?? "?" : "—";
    out.push(`| ${s.label} | ${s.handle} | ${s.escolhidos} | ${u} | ${s.comprometidos} | ${s.candidatos} | ${table} | ${collectionStates.get(s.handle) ?? "não verificado"} |`);
  }
  out.push("");

  out.push(`## Por nome`);
  out.push("");
  out.push(`| Âmbito | Nome | Pri | Modo | Total no catálogo | Dentro do universo | Órfãos (B) | Candidatos | Já publ./aprov. | Escolhidos com teto | Escolhidos sem teto | Suplentes |`);
  out.push(`|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|`);
  for (const n of result.perName) {
    out.push(`| ${n.scope} | ${n.name} | P${n.priority} | ${n.mode} | ${n.totalCatalog} | ${n.dentro} | ${n.orfaos} | ${n.candidatos} | ${n.comprometidos} | ${n.escolhidos} | ${semTeto(n)} | ${n.suplentes} |`);
  }
  out.push("");

  const passB = result.perName.filter((n) => n.mode === "A+B");
  out.push(`## Passagem B — órfãos recuperáveis por nome (sem \`sim\` no CSV)`);
  out.push("");
  out.push(`| Âmbito | Nome | Órfãos que batem no nome | Elegíveis (passam os filtros) |`);
  out.push(`|---|---|---:|---:|`);
  for (const n of passB) {
    out.push(`| ${n.scope} | ${n.name} | ${n.orfaos} | ${n.orfaosElegiveis} |`);
  }
  out.push("");

  // Nenhum nome cai em silêncio: a lista usa a seleção sem teto quando existe, para só
  // aparecer aqui o que realmente não tem nada a importar (e não o que o teto cortou).
  const base = uncapped || result;
  const zeros = base.perName.filter((n) => n.escolhidos === 0);
  out.push(`## Nomes sem candidatos (${zeros.length} de ${base.perName.length})`);
  out.push("");
  if (zeros.length) {
    out.push(`| Âmbito | Nome | Motivo |`);
    out.push(`|---|---|---|`);
    for (const n of zeros) out.push(`| ${n.scope} | ${n.name} | ${n.zero} |`);
  } else out.push(`Nenhum.`);
  out.push("");

  const semCandidatos = result.perScope.filter((s) => s.candidatos === 0);
  if (semCandidatos.length) {
    out.push(`## Universos sem nenhum candidato`);
    out.push("");
    out.push(semCandidatos.map((s) => `- ${s.label} — sai do lote`).join("\n"));
    out.push("");
  }

  out.push(`## Amostras obrigatórias (até ${SAMPLE_SIZE} títulos por nome: epónimos, nomes curtos, Din Djarin)`);
  out.push("");
  for (const n of result.perName.filter((x) => x.samples)) {
    out.push(`### ${n.name} — ${n.scope} (${n.dentro} dentro do universo)`);
    if (!n.samples.length) out.push(`- (sem correspondências no universo)`);
    for (const s of n.samples) out.push(`- ${s.sku} · ${s.title} _(${s.label})_`);
    out.push("");
  }
  return out.join("\n");
}

/** Linha de consola curta por universo (dry-run). */
export function formatScopeLine(s) {
  return `${pad(s.label, 34)} escolhidos ${String(s.escolhidos).padStart(3)} · candidatos ${String(s.candidatos).padStart(4)} · já publ./aprov. ${s.comprometidos}`;
}
