#!/usr/bin/env node
/**
 * Briefing backend 09/10/2026 — Importação por personagem.
 *
 * Aprova (PENDING → APPROVED) os produtos que correspondem à lista de personagens do
 * Carlos e deixa a publicação ao caminho que já existe (`npm run franchise:run-approved-sync`
 * → runApprovedShopifySync, sem alterações). Repetível: a lista vive num ficheiro de
 * dados versionado (character-import-2026-10-09.json) e as próximas rondas trocam só o
 * ficheiro (`--input`).
 *
 * MODOS
 *   (sem flags)                       DRY-RUN — lê catálogo e fila, escreve só o CSV e o
 *                                     resumo em reports/. Não escreve na fila nem na loja.
 *   --execute --from-csv <csv>        Aprova EXATAMENTE as linhas `aprovar = sim` do CSV que
 *                                     o Carlos reviu. Nunca recalcula a seleção. Revalida
 *                                     cada SKU (ainda PENDING, stock > 0) e reporta os que
 *                                     caíram. Idempotente: a segunda corrida não altera nada.
 *   --verify --from-csv <csv>         Só leitura. Estado da fila dos SKUs do CSV e preço live
 *                                     contra o preço do CSV (verificação pós-publish).
 *   --preflight                       Só leitura. P3 (fila), P4 (apagados), P5 (preço), P6
 *                                     (coleções por canal). P1 e P2 são scripts que já existem.
 *
 * FLAGS
 *   --input <ficheiro>   lista de personagens (omissão: character-import-2026-10-09.json)
 *   --cap-p1 N / --cap-p2 N   tetos por personagem (omissão: 2 e 1); 0 = sem teto
 *   --both               dry-run: escreve também o CSV sem teto (<out>-sem-teto.csv) e o resumo
 *                        traz as duas contagens lado a lado
 *   --only-universe <handle>  limita a um âmbito (handle do universo, ou da Line: the-mandalorian)
 *   --out <csv>          caminho do CSV de candidatos (omissão: reports/character-import/)
 *   --confirm-count N    obrigatório em --execute acima de 50 SKUs (D1): o número exato
 *   --shop <loja>
 *
 * Correr na Fly (a BD e a fila vivem lá):
 *   node scripts/catalog/character-import.js --only-universe dragon-ball
 *   node scripts/catalog/character-import.js --execute --from-csv <csv> --only-universe dragon-ball
 *   npm run franchise:run-approved-sync
 *   node scripts/catalog/character-import.js --verify --from-csv <csv> --only-universe dragon-ball
 *
 * Nada aqui chama API de AI nem traduz títulos: os avisos B18 correm sobre o título limpo.
 * A fila é um JSON único (loadCurationQueue), lido uma vez; o catálogo lê-se por cursor.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { loadCurationQueue, bulkSetQueueStatus } from "../../lib/curation/curationQueue.server.js";
import { loadShopSettings } from "../../lib/importer/settings.server.js";
import { resolveMarginPct } from "../../lib/importer/pricing/pricing.server.js";
import { readCatalogRebuildStatus } from "../../lib/importer/catalog/catalogRebuildStatus.server.js";
import { assertBulkConfirm, BulkConfirmError } from "../../lib/curation/bulkConfirm.js";
import { buildProductDescriptionHtml } from "../../lib/importer/shopify/shopifyMapper.server.js";
import { runPrePublishChecks } from "../../lib/importer/curation/prePublishChecks.server.js";
import { reportPath } from "../../lib/maintenance/reportsDir.js";
import {
  DEFAULT_CAP_P1,
  DEFAULT_CAP_P2,
  buildScopes,
  filterDataByHandle,
  createCollector,
  buildCsv,
  buildSummaryMarkdown,
  parseApprovalCsv,
  planApproval,
  scopeHandleOf,
  formatScopeLine,
} from "../../lib/importer/catalog/characterImportSelect.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const KNOWN_FLAGS = new Set(["--input", "--cap-p1", "--cap-p2", "--both", "--only-universe", "--out", "--execute", "--from-csv", "--confirm-count", "--verify", "--preflight", "--shop"]);
const FLAGS_WITH_VALUE = new Set(["--input", "--cap-p1", "--cap-p2", "--only-universe", "--out", "--from-csv", "--confirm-count", "--shop"]);
const valOf = (f, d = null) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const SHOP = valOf("--shop", process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com");
const INPUT = valOf("--input", path.join(HERE, "character-import-2026-10-09.json"));
const ONLY = valOf("--only-universe");
const FROM_CSV = valOf("--from-csv");
const EXECUTE = args.includes("--execute");
const BOTH = args.includes("--both");
const VERIFY = args.includes("--verify");
const PREFLIGHT = args.includes("--preflight");
const PAGE = 500;
const CHUNK = 500;

const CATALOG_SELECT = {
  sku: true,
  title: true,
  cleanTitle: true,
  titleOverride: true,
  vendor: true,
  stock: true,
  imageUrl: true,
  distributorPrice: true,
  grossPrice: true,
  barcode: true,
  categoryMain: true,
  categorySegments: true,
  franchises: true,
  resolvedFranchise: true,
  resolvedLine: true,
  resolvedFormat: true,
};

function die(msg) {
  console.error(`\n${msg}`);
  process.exit(1);
}

function parseCap(flag, fallback) {
  const raw = valOf(flag);
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) die(`${flag} tem de ser um inteiro >= 0 (recebi "${raw}").`);
  return n;
}

function checkArgs() {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) {
      if (i > 0 && FLAGS_WITH_VALUE.has(args[i - 1])) continue;
      die(`Argumento inesperado "${a}".`);
    }
    if (!KNOWN_FLAGS.has(a)) die(`Flag desconhecida "${a}".`);
    if (FLAGS_WITH_VALUE.has(a) && (args[i + 1] == null || args[i + 1].startsWith("--"))) die(`${a} precisa de um valor.`);
  }
  const modes = [EXECUTE, VERIFY, PREFLIGHT].filter(Boolean).length;
  if (modes > 1) die("--execute, --verify e --preflight são exclusivos.");
  if ((EXECUTE || VERIFY) && !FROM_CSV) die(`${EXECUTE ? "--execute" : "--verify"} exige --from-csv <csv>.`);
  if (!EXECUTE && !VERIFY && FROM_CSV) die("--from-csv só se usa com --execute ou --verify.");
}

function loadData() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(INPUT, "utf8"));
  } catch (err) {
    die(`Não consegui ler a lista de personagens (${INPUT}): ${err?.message || err}`);
  }
  if (!Array.isArray(data?.universes)) die(`${INPUT} não tem "universes".`);
  return data;
}

/** Fila → Map sku → { status, queueItem (só o que o preço lê), overridePrice, deletedAt }. */
async function loadQueueIndex() {
  const queue = await loadCurationQueue();
  const bySku = new Map();
  for (const it of queue.items || []) {
    const ov = it.metadata?.overrides;
    const price = Number(ov?.price);
    bySku.set(it.sku, {
      status: it.status,
      queueItem: ov?.marginPct != null ? { metadata: { overrides: { marginPct: ov.marginPct } } } : null,
      overridePrice: Number.isFinite(price) && price > 0 ? price : null,
      deletedAt: it.metadata?.deletedInAdmin?.at ?? null,
      syncError: it.metadata?.syncError ?? null,
      approvedAt: it.metadata?.approvedAt ?? null,
    });
  }
  return bySku;
}

/** O worker de indexação trabalha sobre uma cópia da fila e o catálogo muda a meio:
 *  nem o dry-run nem o execute correm com indexação em curso. */
async function assertNoIndexingRunning(what) {
  const status = await readCatalogRebuildStatus(SHOP);
  if (status?.indexing || status?.state === "running") {
    die(`PARADO: indexação do catálogo a correr — ${what}. Espera que acabe e volta a correr.`);
  }
}

async function readCatalogBySkus(skus) {
  const out = new Map();
  for (let i = 0; i < skus.length; i += CHUNK) {
    const chunk = skus.slice(i, i + CHUNK);
    let rows;
    try {
      rows = await prisma.catalogProduct.findMany({ where: { shop: SHOP, sku: { in: chunk } }, select: CATALOG_SELECT });
    } catch (err) {
      throw new Error(`FALHA DE LEITURA (CatalogProduct por SKU): ${err?.message || err}`);
    }
    for (const r of rows) out.set(r.sku, r);
  }
  return out;
}

async function openShopifyClient() {
  const { loadOfflineSessionForShop } = await import("../../lib/session/loadOfflineSessionForShop.server.js");
  const { createShopifyClientFromSession } = await import("../../lib/importer/shopifyClient.js");
  return createShopifyClientFromSession(await loadOfflineSessionForShop(SHOP));
}

// ───────────────────────── coleções por canal (P6) ─────────────────────────

const COLLECTION_PUBLICATIONS_QUERY = `
  query CharImportCollection($handle: String!) {
    collectionByHandle(handle: $handle) {
      id
      title
      resourcePublicationsV2(first: 25) {
        nodes { isPublished publication { name } }
      }
    }
  }
`;

/** handle → "Online Store: publicada · POS: rascunho" (ou "não existe", ou "erro: …"). */
async function readCollectionStates(handles) {
  const states = new Map();
  let client;
  try {
    client = await openShopifyClient();
  } catch (err) {
    console.warn(`coleções por canal: NÃO VERIFICADAS — ${err?.message || err}`);
    for (const h of handles) states.set(h, "não verificado (sem sessão)");
    return states;
  }
  for (const h of handles) {
    try {
      const d = await client.graphql(COLLECTION_PUBLICATIONS_QUERY, { handle: h });
      const c = d.collectionByHandle;
      if (!c) states.set(h, "NÃO EXISTE na loja");
      else {
        const nodes = c.resourcePublicationsV2?.nodes || [];
        states.set(h, nodes.length ? nodes.map((n) => `${n.publication?.name}: ${n.isPublished ? "publicada" : "rascunho"}`).join(" · ") : "sem canais");
      }
    } catch (err) {
      states.set(h, `erro: ${err?.message || err}`);
    }
  }
  return states;
}

// ───────────────────────── avisos B18 ─────────────────────────

/** Mesmo pipeline do publisher, sem a tradução por API (o dry-run não faz rede de AI). */
function computeWarnings(rows, committed) {
  const seen = new Map();
  for (const { cand } of rows) if (!seen.has(cand.sku)) seen.set(cand.sku, cand.row);
  const payloads = [...seen.values()].map((row) => {
    const title = String(row.titleOverride || row.cleanTitle || row.title || "").replace(/[\r\n\t]/g, " ").trim();
    return {
      sku: row.sku,
      title,
      vendor: String(row.vendor || "").trim() || undefined,
      resolvedFranchise: row.resolvedFranchise ?? null,
      resolvedLine: row.resolvedLine ?? null,
      resolvedFormat: row.resolvedFormat ?? null,
      descriptionHtml: buildProductDescriptionHtml({ ...row, vendor: String(row.vendor || "").trim() || undefined, title }),
    };
  });
  const batch = payloads.map((p) => ({ sku: p.sku, title: p.title }));
  const warningsBySku = new Map();
  for (const p of payloads) {
    const codes = runPrePublishChecks(p, { batch, activeProducts: committed }).map((w) => w.code);
    if (codes.length) warningsBySku.set(p.sku, codes);
  }
  return warningsBySku;
}

// ───────────────────────── dry-run ─────────────────────────

async function runDryRun() {
  const capP1 = parseCap("--cap-p1", DEFAULT_CAP_P1);
  const capP2 = parseCap("--cap-p2", DEFAULT_CAP_P2);
  const data = filterDataByHandle(loadData(), ONLY);
  if (!data.universes.length) die(`--only-universe "${ONLY}" não corresponde a nenhum âmbito do ficheiro.`);
  const scopes = buildScopes(data);
  for (const s of scopes) if (!s.handle) die(`Âmbito sem handle: ${s.label} (universo/Line fora das tabelas).`);

  const out = valOf("--out") || reportPath("character-import", `candidates-${data.id || "run"}${ONLY ? `-${ONLY}` : ""}.csv`);
  console.log(`\n=== character-import · DRY-RUN (${SHOP}) — nada é escrito na fila nem na loja ===`);
  console.log(`lista: ${INPUT} (${scopes.length} âmbito(s), ${scopes.reduce((n, s) => n + s.names.length, 0)} nomes) · tetos P1=${capP1} P2=${capP2}${ONLY ? ` · só ${ONLY}` : ""}`);

  await assertNoIndexingRunning("o dry-run leria uma fila e um catálogo a meio de mudar");
  const globalMarginPct = resolveMarginPct(await loadShopSettings(SHOP));
  console.log(`margem global: ${globalMarginPct} %`);
  const queueBySku = await loadQueueIndex();
  console.log(`fila: ${queueBySku.size} itens`);

  const collector = createCollector({ scopes, queueBySku, globalMarginPct, capP1, capP2 });
  let cursor = null;
  for (;;) {
    let rows;
    try {
      rows = await prisma.catalogProduct.findMany({
        where: { shop: SHOP },
        select: CATALOG_SELECT,
        orderBy: [{ shop: "asc" }, { sku: "asc" }],
        take: PAGE,
        ...(cursor ? { cursor: { shop_sku: cursor }, skip: 1 } : {}),
      });
    } catch (err) {
      throw new Error(`FALHA DE LEITURA (CatalogProduct): ${err?.message || err}`);
    }
    if (!rows.length) break;
    for (const r of rows) collector.addRow(r);
    cursor = { shop: SHOP, sku: rows[rows.length - 1].sku };
    if (rows.length < PAGE) break;
  }

  const result = collector.finalize({ capP1, capP2 });
  const uncapped = BOTH ? collector.finalize({ capP1: 0, capP2: 0 }) : null;
  const warningsBySku = computeWarnings([...result.rows, ...(uncapped?.rows || [])], result.committed);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buildCsv(result.rows, { warningsBySku }), "utf8");
  const outUncapped = out.replace(/\.csv$/i, "") + "-sem-teto.csv";
  if (uncapped) fs.writeFileSync(outUncapped, buildCsv(uncapped.rows, { warningsBySku }), "utf8");

  const collectionStates = await readCollectionStates(result.perScope.map((s) => s.handle));
  const summaryPath = out.replace(/\.csv$/i, "") + ".summary.md";
  fs.writeFileSync(
    summaryPath,
    buildSummaryMarkdown(result, {
      uncapped,
      collectionStates,
      meta: { lista: path.basename(INPUT), "tetos (P1/P2; 0 = sem teto)": `${capP1}/${capP2}`, "margem global": `${globalMarginPct} %`, loja: SHOP },
    }),
    "utf8"
  );

  console.log(`\nlinhas de catálogo lidas: ${result.totals.rowsSeen}`);
  console.log(`escolhidos com teto: ${result.totals.escolhidos} · suplentes: ${result.totals.suplentes}${uncapped ? ` · escolhidos sem teto: ${uncapped.totals.escolhidos}` : ""} · com aviso B18: ${warningsBySku.size}`);
  console.log(`\npor universo:`);
  for (const s of result.perScope) console.log(`  ${formatScopeLine(s)}${uncapped ? ` · sem teto ${uncapped.perScope.find((x) => x.label === s.label)?.escolhidos}` : ""}  | coleção: ${collectionStates.get(s.handle) ?? "?"}`);
  const zeros = (uncapped || result).perName.filter((n) => n.escolhidos === 0);
  console.log(`\nnomes sem candidatos (${zeros.length}):`);
  for (const n of zeros) console.log(`  ${n.scope} · ${n.name}: ${n.zero}`);
  const orphanPicks = (uncapped || result).rows.filter((r) => r.cand.source === "B").length;
  if (orphanPicks) console.log(`\n⚠ ${orphanPicks} linha(s) da passagem B (órfãos sem universo) — vão SEM aprovar no CSV; ver a coluna "nota".`);
  console.log(`\nCSV:     ${out}${uncapped ? `\nCSV sem teto: ${outUncapped}` : ""}`);
  console.log(`Resumo:  ${summaryPath}`);
  console.log(`Próximo: o Carlos revê a coluna "aprovar" e corre --execute --from-csv.\n`);
}

// ───────────────────────── execute ─────────────────────────

function csvRowsForRun() {
  let text;
  try {
    text = fs.readFileSync(FROM_CSV, "utf8");
  } catch (err) {
    die(`Não consegui ler o CSV (${FROM_CSV}): ${err?.message || err}`);
  }
  try {
    return parseApprovalCsv(text);
  } catch (err) {
    die(`CSV inválido: ${err?.message || err}`);
  }
}

async function runExecute() {
  const csvRows = csvRowsForRun();
  console.log(`\n=== character-import · EXECUTE (${SHOP}) ===`);
  console.log(`CSV: ${FROM_CSV} · ${csvRows.length} linhas${ONLY ? ` · só ${ONLY}` : ""}`);

  await assertNoIndexingRunning("o worker trabalha sobre uma cópia da fila e desfazia a aprovação");

  const wanted = [...new Set(csvRows.filter((r) => r.aprovar === "sim" && r.sku).map((r) => r.sku))];
  const queueBySku = await loadQueueIndex();
  const catalog = await readCatalogBySkus(wanted);
  const current = new Map(
    wanted.map((sku) => {
      const q = queueBySku.get(sku);
      const c = catalog.get(sku);
      return [sku, { status: q?.status ?? null, inCatalog: Boolean(c), stock: c?.stock ?? null, imageUrl: c?.imageUrl ?? null, distributorPrice: c?.distributorPrice ?? null }];
    })
  );

  const plan = planApproval(csvRows, current, { onlyHandle: ONLY });
  console.log(`\nlinhas aprovar=sim: ${plan.toApprove.length + plan.alreadyDone.length + plan.dropped.length}${ONLY ? ` (fora do âmbito: ${plan.outOfScope})` : ""}`);
  console.log(`  a aprovar agora:        ${plan.toApprove.length}`);
  console.log(`  já aprovadas/publicadas: ${plan.alreadyDone.length}`);
  console.log(`  caíram na revalidação:   ${plan.dropped.length}`);
  for (const d of plan.dropped) console.log(`    ✗ ${d.sku || "(sem SKU)"} — ${d.reason}`);

  if (!plan.toApprove.length) {
    console.log(`\nNada a aprovar — nenhuma escrita.\n`);
    return;
  }

  try {
    assertBulkConfirm(plan.toApprove.length, valOf("--confirm-count") == null ? null : Number(valOf("--confirm-count")), { what: "a aprovação deste lote" });
  } catch (err) {
    if (err instanceof BulkConfirmError) die(`${err.message}\nVolta a correr com --confirm-count ${plan.toApprove.length}.`);
    throw err;
  }

  const { updatedItems } = await bulkSetQueueStatus(plan.toApprove, "APPROVED");
  console.log(`\naprovados: ${updatedItems.length} (metadata.approvedAt gravado)`);

  const after = await loadQueueIndex();
  const approvedNow = [...after.values()].filter((v) => v.status === "APPROVED").length;
  const mine = new Set(plan.toApprove);
  const strangers = [...after.entries()].filter(([sku, v]) => v.status === "APPROVED" && !mine.has(sku)).length;
  console.log(`fila: APPROVED = ${approvedNow}${strangers ? ` — ⚠ ${strangers} fora deste CSV (o publish publica TUDO o que está APPROVED)` : ""}`);
  console.log(`\nPublicar: npm run franchise:run-approved-sync`);
  console.log(`Depois:   node scripts/catalog/character-import.js --verify --from-csv ${FROM_CSV}${ONLY ? ` --only-universe ${ONLY}` : ""}\n`);
}

// ───────────────────────── verify ─────────────────────────

async function runVerify() {
  const csvRows = csvRowsForRun();
  const sim = csvRows.filter((r) => r.aprovar === "sim" && r.sku && (!ONLY || scopeHandleOf(r) === ONLY));
  const skus = [...new Set(sim.map((r) => r.sku))];
  const csvPrice = new Map(sim.filter((r) => r.price != null).map((r) => [r.sku, r.price]));
  console.log(`\n=== character-import · VERIFY (${SHOP}) — só leitura ===`);
  console.log(`SKUs aprovados no CSV: ${skus.length}${ONLY ? ` · só ${ONLY}` : ""}`);

  const queueBySku = await loadQueueIndex();
  const byStatus = {};
  const syncErrors = [];
  for (const sku of skus) {
    const q = queueBySku.get(sku);
    const st = q?.status ?? "AUSENTE";
    byStatus[st] = (byStatus[st] || 0) + 1;
    if (st === "SYNC_ERROR") syncErrors.push({ sku, error: q.syncError });
  }
  const allApproved = [...queueBySku.values()].filter((v) => v.status === "APPROVED").length;
  const allSyncError = [...queueBySku.values()].filter((v) => v.status === "SYNC_ERROR").length;
  console.log(`\nfila (dos SKUs do CSV): ${JSON.stringify(byStatus)}`);
  console.log(`fila (global): APPROVED = ${allApproved} · SYNC_ERROR = ${allSyncError}`);
  for (const e of syncErrors) console.log(`  ✗ ${e.sku}: ${e.error || "(sem mensagem)"}`);

  let red = false;
  const published = byStatus.PUBLISHED || 0;
  if (published !== skus.length) red = true;
  if (allApproved !== 0 || allSyncError !== 0) red = true;

  const published_skus = skus.filter((s) => queueBySku.get(s)?.status === "PUBLISHED");
  try {
    const { fetchLiveVariantsBySku } = await import("../../lib/importer/shopify/liveVariantsBySku.server.js");
    const client = await openShopifyClient();
    const live = await fetchLiveVariantsBySku(client, published_skus);
    const missing = published_skus.filter((s) => !live.has(s));
    const dup = published_skus.filter((s) => live.get(s)?.duplicate);
    const wrong = [];
    for (const s of published_skus) {
      const lv = live.get(s);
      const want = csvPrice.get(s);
      if (lv && want != null && Math.abs(lv.price - want) > 0.005) wrong.push({ sku: s, live: lv.price, csv: want });
    }
    console.log(`\nloja: ${live.size}/${published_skus.length} SKUs publicados encontrados`);
    for (const s of missing) console.log(`  ✗ sem variante live: ${s}`);
    for (const s of dup) console.log(`  ✗ SKU duplicado na loja: ${s}`);
    for (const w of wrong) console.log(`  ✗ preço ${w.sku}: loja ${w.live} ≠ CSV ${w.csv}`);
    console.log(`preço live = preço do CSV: ${published_skus.length - wrong.length - missing.length}/${published_skus.length}`);
    if (missing.length || dup.length || wrong.length) red = true;
  } catch (err) {
    console.log(`\nloja: NÃO VERIFICADA (${err?.message || err})`);
    red = true;
  }

  console.log(`\nResto da verificação (scripts que já existem):`);
  console.log(`  npm run franchise:reconcile          # MISSING 0, DRIFT 0, ORPHAN_LINE 0, UNKNOWN 0, NO_CATALOG_ROW 0`);
  console.log(`  npm run catalog:health               # verde, exit 0`);
  console.log(`  alterpop.franchise em todos; alterpop.line só nos Mandalorian; coleção do universo — via franchise:reconcile`);
  console.log(`\n${red ? "VERMELHO" : "VERDE (fila e preço)"}\n`);
  if (red) process.exitCode = 1;
}

// ───────────────────────── preflight ─────────────────────────

async function runPreflight() {
  console.log(`\n=== character-import · PREFLIGHT (${SHOP}) — só leitura ===\n`);
  const queueBySku = await loadQueueIndex();
  const byStatus = {};
  let deletedPending = 0;
  let deletedOther = 0;
  for (const v of queueBySku.values()) {
    byStatus[v.status] = (byStatus[v.status] || 0) + 1;
    if (v.deletedAt) v.status === "PENDING" ? deletedPending++ : deletedOther++;
  }
  const p3 = (byStatus.APPROVED || 0) === 0 && (byStatus.SYNC_ERROR || 0) === 0;
  console.log(`P3  fila: ${JSON.stringify(byStatus)}  →  APPROVED=${byStatus.APPROVED || 0}, SYNC_ERROR=${byStatus.SYNC_ERROR || 0}  ${p3 ? "OK" : "VERMELHO"}`);
  console.log(`P4  apagados no admin: ${deletedPending} em PENDING, ${deletedOther} noutro estado (esperado: 157 em PENDING, 0 em REJECTED)`);

  const margin = resolveMarginPct(await loadShopSettings(SHOP));
  const { priceProduct } = await import("../../lib/importer/pricing/pricing.server.js");
  const ex = priceProduct(9.99, 24.99, margin);
  console.log(`P5  preço: custo = precio_distribuidores × 1,21 → margem global ${margin} % → arredondamento ,50/,90. Exemplo: distribuidor 9,99 / PVPR 24,99 → custo ${ex.cost.toFixed(2)} → ${ex.finalPrice.toFixed(2)} (${ex.priceStatus})`);

  const data = loadData();
  const handles = [...new Set(buildScopes(data).map((s) => s.handle))];
  console.log(`\nP6  coleções dos universos da lista, por canal:`);
  const states = await readCollectionStates(handles);
  for (const h of handles) console.log(`    ${h.padEnd(26)} ${states.get(h)}`);
  console.log(`\nP1: npm run catalog:health   ·   P2: node scripts/catalog/franchise-conditions-diff.js\n`);
}

// ───────────────────────── main ─────────────────────────

async function main() {
  checkArgs();
  if (PREFLIGHT) return runPreflight();
  if (EXECUTE) return runExecute();
  if (VERIFY) return runVerify();
  return runDryRun();
}

main()
  .catch((err) => {
    console.error(`\n${err?.stack || err?.message || err}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
