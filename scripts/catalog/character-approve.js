#!/usr/bin/env node
/* eslint-env node */
/**
 * Briefing backend 04/11/2026 — aprovação por personagem.
 *
 * Passa a APPROVED os produtos PENDING cujo título tem um personagem da lista fechada
 * (27 franquias, P1 e P2), no universo da linha, com custo bruto > 5,00 € e dentro do
 * filtro de âmbito (coleccionáveis da decisão de 15/09, mais Loungefly). Não publica.
 * Não mexe na margem. A publicação é do Carlos, no painel.
 *
 * MODOS
 *   (sem flags)                      DRY-RUN — só leitura. Escreve o CSV e o resumo em
 *                                    reports/character-approve/. Não toca na fila nem na loja.
 *   --execute --confirm-count N      Só com OK do arquiteto. Recalcula a seleção, exige N igual
 *                                    ao total de agora, e grava sob o lock da fila:
 *                                    status APPROVED, metadata.approvedAt e
 *                                    metadata.importOrigin = character-import-2026-11-04. Revalida cada SKU
 *                                    (PENDING; apagado no admin entra). Recusa candidato sem
 *                                    resolvedFranchise. Órfãos ficam fora. Idempotente.
 *   Reversão: scripts/catalog/character-approve-revert.js (mesma origem).
 *
 * FLAGS
 *   --input <ficheiro>   lista (omissão: character-import-2026-10-09.json — a lista de hoje;
 *                        aliases do briefing, nomes de risco e origem vêm de characterApproval.js)
 *   --out <csv>          caminho do CSV (omissão: reports/character-approve/)
 *   --shop <loja>
 *
 * Saída de consola: só contagens, nomes e títulos (o log do fly-ops é público). Os custos
 * ficam no CSV, em reports/.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { loadCurationQueue, mutateCurationQueue } from "../../lib/curation/curationQueue.server.js";
import { readCatalogRebuildStatus } from "../../lib/importer/catalog/catalogRebuildStatus.server.js";
import { reportPath } from "../../lib/maintenance/reportsDir.js";
import { recusarSeAtividadeApp } from "../../lib/curation/atividadeApp.js";
import {
  buildApprovalScopes,
  createApprovalCollector,
  buildApprovalCsv,
  buildOrphanCsv,
  assertAllHaveFranchise,
  ORIGIN,
  buildApprovalSummary,
  applyApproval,
  formatDuration,
  reasonLabel,
  PUBLISH_SECONDS_PER_PRODUCT,
} from "../../lib/importer/catalog/characterApproval.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const KNOWN_FLAGS = new Set(["--input", "--out", "--execute", "--confirm-count", "--shop"]);
const FLAGS_WITH_VALUE = new Set(["--input", "--out", "--confirm-count", "--shop"]);
const valOf = (f, d = null) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const SHOP = valOf("--shop", process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com");
const INPUT = valOf("--input", path.join(HERE, "character-import-2026-10-09.json"));
const EXECUTE = args.includes("--execute");
const PAGE = 500;

const CATALOG_SELECT = {
  sku: true,
  title: true,
  cleanTitle: true,
  originalTitle: true,
  vendor: true,
  stock: true,
  distributorPrice: true,
  resolvedFranchise: true,
  resolvedLine: true,
  resolvedFormat: true,
};

function die(msg) {
  console.error(`\n${msg}`);
  process.exit(1);
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
  if (EXECUTE && valOf("--confirm-count") == null) die("--execute exige --confirm-count N (o total do dry-run).");
  if (!EXECUTE && valOf("--confirm-count") != null) die("--confirm-count só se usa com --execute.");
}

function loadData() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(INPUT, "utf8"));
  } catch (err) {
    die(`Não consegui ler a lista (${INPUT}): ${err?.message || err}`);
  }
  if (!Array.isArray(data?.universes)) die(`${INPUT} sem "universes".`);
  return data;
}

async function loadQueueIndex() {
  const queue = await loadCurationQueue();
  const bySku = new Map();
  for (const it of queue.items || []) {
    bySku.set(it.sku, { status: it.status, deletedAt: it.metadata?.deletedInAdmin?.at ?? (it.metadata?.deletedInAdmin ? "sim" : null) });
  }
  return bySku;
}

async function assertNoIndexingRunning(what) {
  const status = await readCatalogRebuildStatus(SHOP);
  if (status?.indexing || status?.state === "running") die(`PARADO: indexação do catálogo a correr — ${what}. Espera que acabe e volta a correr.`);
}

async function select(scopes) {
  const queueBySku = await loadQueueIndex();
  console.log(`fila: ${queueBySku.size} itens`);
  const collector = createApprovalCollector({ scopes, queueBySku });
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
  return collector.finalize();
}

function printConsole(result) {
  const t = result.totals;
  console.log(`\nlinhas de catálogo lidas: ${result.rowsSeen}`);
  console.log(`candidatos (com filtro de âmbito): ${t.total} · P1 ${t.p1} · P2 ${t.p2}`);
  console.log(`PENDING apagados no admin incluídos: ${t.apagados}`);
  console.log(`órfãos da passagem B, fora do execute: ${t.orfaos} (passariam os outros filtros: ${t.orfaosElegiveis})`);
  console.log(`sem filtro de âmbito: ${t.semFiltro} · só filtro base: ${t.soBase} · base + Loungefly: ${t.total}`);
  console.log(`Loungefly: ${t.loungefly} (via base FUNKO ${t.loungeflyBase}; só pela exceção ${t.loungeflyExcecao})`);
  console.log(`sem stock: ${t.semStock}`);
  console.log(`publish estimado: ${formatDuration(t.publishSeconds)} (${PUBLISH_SECONDS_PER_PRODUCT} s/produto)`);
  console.log(`\nexcluídos:`);
  for (const [r, n] of Object.entries(result.excluded).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${reasonLabel(r)}`);
  console.log(`\npor franquia (total · P1 · P2 · Loungefly):`);
  for (const s of result.perScope) console.log(`  ${s.label.padEnd(34)} ${String(s.total).padStart(5)} · ${String(s.p1).padStart(4)} · ${String(s.p2).padStart(4)} · ${s.loungefly}`);
  const zeros = result.perName.filter((n) => n.candidates === 0);
  console.log(`\npersonagens com zero candidatos (${zeros.length}):`);
  for (const n of zeros) console.log(`  ${n.scope} · ${n.name} (P${n.priority})`);
  console.log(`\naliases do B7 fora do briefing (no universo · candidatos · só por este alias):`);
  for (const b of result.b7Aliases) console.log(`  ${b.scope} · ${b.name} · "${b.alias}": ${b.inUniverse} · ${b.candidates} · ${b.onlyVia}`);
  if (!result.b7Aliases.length) console.log(`  (nenhuma correspondência)`);
  console.log(`\ntop fabricantes excluídos pelo filtro de âmbito:`);
  for (const v of result.topExcludedVendors) console.log(`  ${String(v.count).padStart(6)}  ${v.vendor}`);
  console.log(`\nnomes de risco (candidatos · no universo · fora do universo):`);
  for (const n of result.perName.filter((x) => x.risk)) {
    console.log(`  ${n.name} — ${n.scope}: ${n.candidates} · ${n.inUniverse} · ${n.outUniverse}`);
    for (const s of n.samples) console.log(`      ${s.sku} · ${s.title} (${s.label})`);
  }
}

async function runDryRun(data, scopes) {
  const out = valOf("--out") || reportPath("character-approve", `candidates-${ORIGIN}.csv`);
  console.log(`\n=== character-approve · DRY-RUN (${SHOP}) — nada é escrito na fila nem na loja ===`);
  console.log(`lista: ${path.basename(INPUT)} (${scopes.length} âmbitos, ${scopes.reduce((n, s) => n + s.names.length, 0)} nomes) · origem ${ORIGIN}`);
  await assertNoIndexingRunning("o dry-run leria uma fila e um catálogo a meio de mudar");
  const result = await select(scopes);

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buildApprovalCsv(result, scopes), "utf8");
  const orphansPath = out.replace(/\.csv$/i, "") + "-orfaos.csv";
  fs.writeFileSync(orphansPath, buildOrphanCsv(result, scopes), "utf8");
  const summaryPath = out.replace(/\.csv$/i, "") + ".summary.md";
  fs.writeFileSync(summaryPath, buildApprovalSummary(result, { meta: { lista: path.basename(INPUT), origem: ORIGIN, loja: SHOP } }), "utf8");

  printConsole(result);
  console.log(`\nCSV:    ${out}`);
  console.log(`Órfãos: ${orphansPath}`);
  console.log(`Resumo: ${summaryPath}`);
  console.log(`Próximo (só com OK do arquiteto): node scripts/catalog/character-approve.js --execute --confirm-count ${result.totals.total}\n`);
}

async function runExecute(data, scopes) {
  const confirm = Number(valOf("--confirm-count"));
  console.log(`\n=== character-approve · EXECUTE (${SHOP}) — origem ${ORIGIN} ===`);
  await assertNoIndexingRunning("o worker trabalha sobre uma cópia da fila e desfazia a aprovação");
  const result = await select(scopes);
  printConsole(result);
  try {
    assertAllHaveFranchise(result.candidates);
  } catch (err) {
    die(`PARADO: ${err.message}`);
  }
  const skus = result.candidates.map((c) => c.sku);
  if (!Number.isInteger(confirm) || confirm !== skus.length) {
    die(`PARADO: --confirm-count ${valOf("--confirm-count")} ≠ ${skus.length} candidatos de agora. Nada escrito. Revê o dry-run e volta a correr.`);
  }
  if (!skus.length) {
    console.log(`\nNada a aprovar — nenhuma escrita.\n`);
    return;
  }

  const now = new Date().toISOString();
  const res = await mutateCurationQueue((fila) => {
    const r = applyApproval(fila, skus, { origin: ORIGIN, now });
    return { gravar: r.approved.length > 0, valor: r };
  });

  console.log(`\naprovados agora: ${res.approved.length}`);
  console.log(`já aprovados por esta origem: ${res.already.length}`);
  console.log(`caíram na revalidação: ${res.dropped.length}`);
  for (const d of res.dropped) console.log(`  ✗ ${d.sku} — ${d.reason}`);
  console.log(`metadata.approvedAt = ${now} · metadata.importOrigin = ${ORIGIN}`);
  console.log(`publish estimado: ${formatDuration(res.approved.length * PUBLISH_SECONDS_PER_PRODUCT)}`);
  console.log(`\nPublicar: é do Carlos, no painel. Reverter: node scripts/catalog/character-approve-revert.js\n`);
}

async function main() {
  recusarSeAtividadeApp("character-approve");
  checkArgs();
  const data = loadData();
  const scopes = buildApprovalScopes(data);
  if (EXECUTE) return runExecute(data, scopes);
  return runDryRun(data, scopes);
}

main()
  .catch((err) => {
    console.error(`\n${err?.stack || err?.message || err}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
