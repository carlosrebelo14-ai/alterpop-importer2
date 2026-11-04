/**
 * Aprovação por personagem (briefing backend 04/11/2026) — lógica pura de seleção,
 * relatório e plano de escrita/reversão. Sem Prisma, sem Shopify, sem escrita: os
 * scripts scripts/catalog/character-approve.js e character-approve-revert.js tratam do
 * I/O e chamam isto. Coberto por scripts/tests/character-approve.test.js.
 *
 * Diferenças para a ronda de 09/10 (characterImportSelect.js):
 *  - sem tetos: entram TODOS os SKUs elegíveis;
 *  - custo bruto (distributorPrice = precio_distribuidores) > 5,00 €;
 *  - stock não filtra, só se conta;
 *  - The Mandalorian exige só resolvedFranchise Star Wars (a Line não é obrigatória) e
 *    Star Wars deixa de excluir a Line;
 *  - âmbito: filtro de coleccionáveis (15/09, PR #76) OU Loungefly (exceção);
 *  - escrita direta na fila com marca de origem, revertível pela mesma marca.
 *
 * Correspondência — nome ou alias no cleanTitle (fallback title), palavra inteira, sem
 * distinção de maiúsculas nem de acentos, após NFC (normalizeForMatch de 09/10).
 */
import { CHARACTER_ALIASES } from "./characterVocabulary.js";
import { isCollectibleVendor } from "./manufacturerTierResolver.server.js";
import { normalizeForMatch } from "./characterImportSelect.js";

export { normalizeForMatch };

/** Custo bruto mínimo, exclusivo: entra só custo > 5,00 €. */
export const MIN_COST_EXCLUSIVE = 5;
/** Segundos por produto no publish (medição do briefing). */
export const PUBLISH_SECONDS_PER_PRODUCT = 5.3;
export const SAMPLE_SIZE = 5;
export const TOP_EXCLUDED_VENDORS = 20;

/** Campos de metadata que a escrita grava e a reversão lê. */
export const META_ORIGIN = "importOrigin";
export const META_PREVIOUS = "importPrevious";

/** Cabeçalho do CSV — colunas do briefing primeiro, depois as de leitura. */
export const CSV_COLUMNS = ["SKU", "titulo", "franquia", "personagem", "custo_bruto", "fabricante", "stock", "prioridade", "passagem", "ambito", "loungefly"];

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
 * Âmbitos (uma linha da tabela = um âmbito) a partir do ficheiro de dados.
 * @param {object} data conteúdo de character-approve-2026-11-04.json
 * @param {{ vocabAliases?: Record<string,string[]> }} [opts]
 */
export function buildApprovalScopes(data, { vocabAliases = CHARACTER_ALIASES } = {}) {
  const risk = new Set(data.riskNames || []);
  return data.universes.map((row, scopeIndex) => {
    const universe = nfc(row.universe);
    const line = row.line || null;
    const names = row.characters.map((c, nameIndex) => {
      const aliases = unique([c.name, ...(vocabAliases[c.name] || []), ...(c.aliases || [])]);
      return {
        key: `${scopeIndex}:${nameIndex}`,
        scopeIndex,
        nameIndex,
        name: c.name,
        priority: c.priority === 1 ? 1 : 2,
        mode: c.mode === "A+B" ? "A+B" : "A",
        risk: risk.has(c.name),
        aliases,
        phrases: unique(aliases.map(normalizeForMatch).filter(Boolean)),
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

/** Índice de frases → nomes, para procurar cada título uma só vez. */
export function buildMatcher(scopes) {
  const needles = new Map();
  for (const s of scopes) {
    for (const e of s.names) {
      for (const p of e.phrases) {
        const n = ` ${p} `;
        if (!needles.has(n)) needles.set(n, []);
        needles.get(n).push(e);
      }
    }
  }
  const list = [...needles.keys()];
  /** @returns {Map<string, object>} key → entrada do nome */
  return function match(title) {
    const hay = ` ${normalizeForMatch(title)} `;
    const hit = new Map();
    for (const n of list) {
      if (!hay.includes(n)) continue;
      for (const e of needles.get(n)) hit.set(e.key, e);
    }
    return hit;
  };
}

const byRank = (a, b) => a.priority - b.priority || a.scopeIndex - b.scopeIndex || a.nameIndex - b.nameIndex;

/**
 * Classifica uma linha do catálogo. Ordem fixa dos motivos (o resumo fica estável):
 *   sem_correspondencia → universo_errado → estado (REJECTED, fora da fila, APPROVED,
 *   PUBLISHED, SYNC_ERROR, apagado no admin) → preco → fora_ambito → candidato.
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
  if (!q) return { ...base, reason: "fora_da_fila" };
  if (q.status === "REJECTED") return { ...base, reason: "rejected" };
  if (q.status !== "PENDING") return { ...base, reason: `estado_${String(q.status).toLowerCase()}` };
  if (q.deletedAt) return { ...base, reason: "apagado_no_admin" };
  const cost = Number(row.distributorPrice);
  if (!(Number.isFinite(cost) && cost > MIN_COST_EXCLUSIVE)) return { ...base, reason: "preco" };
  const sf = scopeFilter(row);
  if (!sf.pass) return { ...base, reason: "fora_ambito", scope: sf };
  return { ...base, reason: null, scope: sf };
}

export const REASON_LABELS = {
  sem_correspondencia: "sem correspondência",
  universo_errado: "universo errado",
  fora_da_fila: "fora da fila de curadoria",
  rejected: "REJECTED",
  estado_approved: "já APPROVED",
  estado_published: "já PUBLISHED",
  estado_sync_error: "em SYNC_ERROR",
  apagado_no_admin: "PENDING apagado no admin (só o Carlos o tira)",
  preco: `custo bruto ≤ ${MIN_COST_EXCLUSIVE.toFixed(2)} € ou sem custo`,
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
 * Colector em streaming. `addRow` vê cada linha uma vez; guarda só os candidatos e os
 * contadores. Um SKU conta uma vez em todos os totais, mesmo com vários personagens; a
 * contagem por personagem conta o SKU em cada nome que bate (a soma passa o total).
 * @param {{ scopes: object[], queueBySku: Map<string, object> }} opts
 */
export function createApprovalCollector({ scopes, queueBySku }) {
  const match = buildMatcher(scopes);
  const entries = scopes.flatMap((s) => s.names);
  const perName = new Map(
    entries.map((e) => [e.key, { catalog: 0, inUniverse: 0, outUniverse: 0, orphans: 0, candidates: 0, semFiltro: 0, reasons: {}, matched: [] }])
  );
  const excluded = {};
  const candidates = [];
  const outOfScopeVendors = new Map();
  let rowsSeen = 0;
  let semFiltro = 0;
  const seen = new Set();

  function addRow(row) {
    rowsSeen += 1;
    if (seen.has(row.sku)) return;
    seen.add(row.sku);
    const title = row.cleanTitle || row.title;
    const hits = match(title);
    if (!hits.size) return;
    const r = classifyRow(row, hits, scopes, queueBySku);
    const rowKey = universeKey(row.resolvedFranchise);
    const matchedKeys = new Set((r.matched || []).map((e) => e.key));

    for (const e of hits.values()) {
      const st = perName.get(e.key);
      st.catalog += 1;
      if (matchedKeys.has(e.key)) {
        if (r.source === "A") st.inUniverse += 1;
        else st.orphans += 1;
        bump(st.reasons, r.reason ?? "candidato");
        if (r.reason === null) st.candidates += 1;
        if (r.reason === null || r.reason === "fora_ambito") st.semFiltro += 1;
        if (e.risk) st.matched.push({ sku: row.sku, title, reason: r.reason, source: r.source });
      } else if (rowKey && rowKey !== scopes[e.scopeIndex].universeKey) {
        st.outUniverse += 1;
        if (e.risk) st.matched.push({ sku: row.sku, title, reason: "universo_errado", universe: row.resolvedFranchise });
      }
    }

    if (r.reason === null || r.reason === "fora_ambito") semFiltro += 1;
    if (r.reason === "fora_ambito") {
      const v = String(row.vendor || "").trim() || "(sem fabricante)";
      outOfScopeVendors.set(v, (outOfScopeVendors.get(v) || 0) + 1);
    }
    if (r.reason !== null) {
      bump(excluded, r.reason);
      return;
    }
    candidates.push({
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
    });
  }

  function finalize() {
    candidates.sort((a, b) => byRank(a.primary, b.primary) || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));

    const perScope = scopes.map((s) => ({ label: s.label, universe: s.universe, line: s.line, total: 0, p1: 0, p2: 0, orfaos: 0, semStock: 0, loungefly: 0, loungeflyBase: 0, loungeflyExcecao: 0 }));
    for (const c of candidates) {
      const ps = perScope[c.primary.scopeIndex];
      ps.total += 1;
      if (c.primary.priority === 1) ps.p1 += 1;
      else ps.p2 += 1;
      if (c.source === "B") ps.orfaos += 1;
      if (!(c.stock > 0)) ps.semStock += 1;
      if (c.scope.loungefly) {
        ps.loungefly += 1;
        if (c.scope.base) ps.loungeflyBase += 1;
        else ps.loungeflyExcecao += 1;
      }
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
          orphans: st.orphans,
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
      perScope,
      perName: names,
      excluded,
      totals: {
        total,
        p1,
        p2: total - p1,
        semFiltro,
        soBase: candidates.filter((c) => c.scope.base).length,
        orfaos: candidates.filter((c) => c.source === "B").length,
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

/** Amostra: candidatos primeiro; sem candidatos, qualquer correspondência. */
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

// ───────────────────────── CSV ─────────────────────────

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV dos candidatos: uma linha por SKU; `personagem` junta os nomes que bateram. */
export function buildApprovalCsv(result, scopes) {
  const lines = [CSV_COLUMNS.map(csvCell).join(",")];
  for (const c of result.candidates) {
    const ambito = c.scope.base ? (c.scope.loungefly ? "coleccionavel+loungefly" : "coleccionavel") : "loungefly";
    lines.push(
      [
        c.sku,
        c.title || "",
        scopes[c.primary.scopeIndex].label,
        c.matched.map((e) => e.name).join(" | "),
        Number.isFinite(c.cost) ? c.cost.toFixed(2) : "",
        c.vendor,
        c.stock,
        `P${c.primary.priority}`,
        c.source,
        ambito,
        c.scope.loungefly ? c.scope.via : "",
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return lines.join("\r\n") + "\r\n";
}

// ───────────────────────── Resumo ─────────────────────────

/**
 * Resumo em Markdown. Só contagens, nomes e títulos: sem custos (o log do fly-ops é
 * público; os custos ficam no CSV em reports/).
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
  out.push(`| Órfãos (passagem B) dentro dos candidatos | ${t.orfaos} |`);
  out.push(`| Candidatos sem stock (não filtra) | ${t.semStock} |`);
  out.push(`| Loungefly nos candidatos | ${t.loungefly} (passa no filtro base: ${t.loungeflyBase}; só pela exceção: ${t.loungeflyExcecao}) |`);
  out.push(`| Estimativa de publish (${PUBLISH_SECONDS_PER_PRODUCT} s/produto) | ${formatDuration(t.publishSeconds)} |`);
  out.push("");
  out.push(`## Excluídos (motivo, primeiro que se aplica)`);
  out.push("");
  out.push(`| Motivo | SKUs |`);
  out.push(`|---|---:|`);
  for (const r of ["universo_errado", "rejected", "fora_da_fila", "estado_approved", "estado_published", "estado_sync_error", "apagado_no_admin", "preco", "fora_ambito"]) {
    out.push(`| ${reasonLabel(r)} | ${ex[r] || 0} |`);
  }
  for (const [r, n] of Object.entries(ex)) if (!(r in REASON_LABELS)) out.push(`| ${r} | ${n} |`);
  out.push("");

  out.push(`## Por franquia`);
  out.push("");
  out.push(`| Franquia | Total | P1 | P2 | Órfãos | Sem stock | Loungefly | Loungefly via base (FUNKO) | Loungefly só pela exceção |`);
  out.push(`|---|---:|---:|---:|---:|---:|---:|---:|---:|`);
  for (const s of result.perScope) {
    out.push(`| ${s.label} | ${s.total} | ${s.p1} | ${s.p2} | ${s.orfaos} | ${s.semStock} | ${s.loungefly} | ${s.loungeflyBase} | ${s.loungeflyExcecao} |`);
  }
  out.push("");

  for (const pr of [1, 2]) {
    out.push(`## Por personagem — P${pr}`);
    out.push("");
    out.push(`| Franquia | Personagem | Modo | No catálogo | No universo | Órfãos | Fora do universo | Sem filtro | Candidatos |`);
    out.push(`|---|---|---|---:|---:|---:|---:|---:|---:|`);
    for (const n of result.perName.filter((x) => x.priority === pr)) {
      out.push(`| ${n.scope} | ${n.name} | ${n.mode} | ${n.catalog} | ${n.inUniverse} | ${n.orphans} | ${n.outUniverse} | ${n.semFiltro} | ${n.candidates} |`);
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

// ───────────────────────── escrita e reversão ─────────────────────────

const PREVIOUS_FIELDS = ["approvedAt", "rejectedAt", "origem"];

/**
 * Aplica a aprovação sobre a fila já lida DENTRO do lock. Revalida cada SKU: só PENDING,
 * não apagado no admin. Guarda o estado anterior em metadata.importPrevious para a
 * reversão. Idempotente: um SKU já marcado com esta origem não volta a ser escrito.
 * Muta `fila.items` no lugar.
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
    if (item.metadata?.deletedInAdmin) {
      dropped.push({ sku, reason: "apagado no admin" });
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
 * Reverte o que `applyApproval` escreveu com esta origem. Só APPROVED volta a PENDING;
 * PUBLISHED, SYNC_ERROR e o que mudou de mão (outra origem) ficam e são reportados — o
 * revert não despublica nada na loja. Muta `fila.items` no lugar.
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
