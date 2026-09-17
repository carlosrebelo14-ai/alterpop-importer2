#!/usr/bin/env node
/**
 * BRIEFING BACKEND · Tarefa 10 / 10b — normalização de títulos, portão dirigido
 * (Decisão 8).
 *
 * Três modos, todos DRY-RUN (nada escrito):
 *   default          amostra aleatória (200 por omissão), antes/depois lado a lado
 *   --targeted       os 5 casos obrigatórios da Decisão 8, antes/depois + regras que
 *                     dispararam em cada um
 *   --random 2000    amostra aleatória grande, com taxa de alteração GLOBAL e POR REGRA
 *
 * `--execute`: percorre TODO o CatalogProduct por página de cursor (memória
 * constante) e grava `originalTitle` (só se ainda não definido) + `cleanTitle`
 * (recalculado sempre). NUNCA toca em `title` nem em `titleOverride`.
 *
 * Correr na Fly:
 *   node scripts/catalog/title-clean-dryrun.js --targeted
 *   node scripts/catalog/title-clean-dryrun.js --random 2000
 *   node scripts/catalog/title-clean-dryrun.js --execute
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { cleanProductTitleWithTrace } from "../../lib/importer/catalog/titleCleaner.server.js";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const TARGETED = args.includes("--targeted");
const valOf = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const SHOP = valOf("--shop", process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com");
const SAMPLE = parseInt(valOf("--sample", "200"), 10) || 200;
const RANDOM_N = args.includes("--random") ? parseInt(valOf("--random", "2000"), 10) || 2000 : null;
const PAGE = 500;

/** Decisão 8 — os 5 casos obrigatórios, por SKU real da loja. */
const TARGETED_SKUS = [
  "196214116979", // Latino Pokemon Mega-Charizard X… — prefixo de fornecedor
  "5010996257277", // Transformers Star Wars The Mandalorian… — marca contraditória
  "5010996361004", // Star Wars The Mandalorian & Grogu - The Mandalorian & Grogu… — franquia repetida
  "pkBatman1308", // Batman offer pack 3.50€ x unit — preço e unidade
  "889698765497", // POP figure Rides Deluxe … Mandalorian … the Mandalorian… — repetição interna
];

async function runTargeted() {
  console.log(`\n=== title-clean-dryrun (${SHOP}) · --targeted (Decisão 8) ===\n`);
  const rows = await prisma.catalogProduct.findMany({
    where: { shop: SHOP, sku: { in: TARGETED_SKUS } },
    select: { sku: true, title: true, resolvedFranchise: true, resolvedLine: true, resolvedFormat: true },
  });
  const bySku = new Map(rows.map((r) => [r.sku, r]));

  let allFired = true;
  for (const sku of TARGETED_SKUS) {
    const r = bySku.get(sku);
    if (!r) {
      console.log(`  ✗ SKU ${sku} não encontrado na loja`);
      allFired = false;
      continue;
    }
    const { result, firedRules } = cleanProductTitleWithTrace(r);
    const changed = result !== r.title;
    console.log(`  ${sku}  ${changed ? "✓ mudou" : "✗ NÃO mudou"}  regras: [${firedRules.join(", ") || "nenhuma"}]`);
    console.log(`    antes : "${r.title}"`);
    console.log(`    depois: "${result}"`);
    if (!changed) allFired = false;
  }
  console.log(`\n${allFired ? "✓ os 5 casos mudaram" : "✗ pelo menos 1 caso NÃO mudou — portão não passa"}`);
}

/** Amostra genuinamente aleatória: lê SKU/título em páginas de cursor (leve — só 4
 *  campos de texto, ~25k linhas cabem em memória sem problema na máquina de 512 MB),
 *  baralha com Fisher-Yates e corta a n. Evita o viés de "os últimos N por SKU" (que
 *  agrupa por prefixo/fornecedor). */
async function fetchAllLite() {
  const out = [];
  let cursor = null;
  for (;;) {
    const rows = await prisma.catalogProduct.findMany({
      where: { shop: SHOP },
      select: { sku: true, title: true, resolvedFranchise: true, resolvedLine: true, resolvedFormat: true },
      orderBy: [{ shop: "asc" }, { sku: "asc" }],
      take: PAGE,
      ...(cursor ? { cursor: { shop_sku: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    out.push(...rows);
    cursor = { shop: SHOP, sku: rows[rows.length - 1].sku };
    if (rows.length < PAGE) break;
  }
  return out;
}

function shuffleSample(arr, n) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

async function runRandomRate(n) {
  console.log(`\n=== title-clean-dryrun (${SHOP}) · amostra aleatória ${n} — taxa por regra ===\n`);
  const all = await fetchAllLite();
  const rows = shuffleSample(all, Math.min(n, all.length));

  let changed = 0;
  const ruleCounts = new Map();
  const samples = [];
  for (const r of rows) {
    const { result, firedRules } = cleanProductTitleWithTrace(r);
    if (result !== r.title) {
      changed += 1;
      for (const rule of firedRules) ruleCounts.set(rule, (ruleCounts.get(rule) || 0) + 1);
      if (samples.length < 15) samples.push({ sku: r.sku, before: r.title, after: result, firedRules });
    }
  }

  console.log(`amostra: ${rows.length}`);
  console.log(`mudaram: ${changed} (${((changed / rows.length) * 100).toFixed(1)}%)\n`);
  console.log(`taxa por regra (sobre a amostra, não sobre "mudaram" — uma linha pode disparar mais que uma regra):`);
  for (const [rule, count] of [...ruleCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${(count / rows.length * 100).toFixed(2)}%  ${rule}`);
  }
  console.log(`\namostra de alterações (${samples.length}):`);
  samples.forEach((s) => {
    console.log(`  ${s.sku}  [${s.firedRules.join(", ")}]`);
    console.log(`    antes : "${s.before}"`);
    console.log(`    depois: "${s.after}"`);
  });
}

async function dryRunSample() {
  const rows = await prisma.catalogProduct.findMany({
    where: { shop: SHOP },
    select: { sku: true, title: true, resolvedFranchise: true, resolvedLine: true, resolvedFormat: true },
    orderBy: [{ shop: "asc" }, { sku: "asc" }],
    take: SAMPLE,
  });

  let changed = 0;
  console.log(`\n=== title-clean-dryrun (${SHOP}) · DRY-RUN · amostra ${rows.length} ===\n`);
  for (const r of rows) {
    const { result } = cleanProductTitleWithTrace(r);
    if (result !== r.title) {
      changed += 1;
      console.log(`  ${r.sku}`);
      console.log(`    antes : "${r.title}"`);
      console.log(`    depois: "${result}"`);
    }
  }
  console.log(`\nmudaram: ${changed}/${rows.length} (${((changed / rows.length) * 100).toFixed(1)}%)`);
  console.log(`\n(nada escrito — dry-run. Para gravar originalTitle/cleanTitle em todo o catálogo: --execute)`);
}

async function execute() {
  const total = await prisma.catalogProduct.count({ where: { shop: SHOP } });
  console.log(`\n=== title-clean-dryrun (${SHOP}) · --execute · CatalogProduct: ${total} ===\n`);

  let processed = 0;
  let changed = 0;
  let cursor = null;
  const ruleCounts = new Map();

  for (;;) {
    const rows = await prisma.catalogProduct.findMany({
      where: { shop: SHOP },
      select: { sku: true, title: true, resolvedFranchise: true, resolvedLine: true, resolvedFormat: true, originalTitle: true, cleanTitle: true },
      orderBy: [{ shop: "asc" }, { sku: "asc" }],
      take: PAGE,
      ...(cursor ? { cursor: { shop_sku: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;

    const updates = [];
    for (const r of rows) {
      const { result: clean, firedRules } = cleanProductTitleWithTrace(r);
      const data = {};
      if (r.originalTitle == null) data.originalTitle = r.title;
      if (r.cleanTitle !== clean) data.cleanTitle = clean;
      if (clean !== r.title) {
        changed += 1;
        // P2 (ADENDA 3, 17/09/2026) — o backfill não trazia contagem por regra, só o
        // total. Mesmo padrão de --random N (runRandomRate acima), aplicado ao catálogo
        // inteiro em vez de uma amostra.
        for (const rule of firedRules) ruleCounts.set(rule, (ruleCounts.get(rule) || 0) + 1);
      }
      if (Object.keys(data).length) {
        updates.push(
          prisma.catalogProduct.update({ where: { shop_sku: { shop: SHOP, sku: r.sku } }, data })
        );
      }
    }
    if (updates.length) await prisma.$transaction(updates);

    processed += rows.length;
    cursor = { shop: SHOP, sku: rows[rows.length - 1].sku };
    if (processed % 5000 === 0 || rows.length < PAGE) console.log(`  ${processed}/${total}…`);
    if (rows.length < PAGE) break;
  }

  // P1 (ADENDA 3, 17/09/2026) — mesma verificação aplicada ao backfill de formato:
  // o catálogo tem escrita concorrente, uma página curta pode ser "a tabela encolheu
  // a meio", não "chegámos ao fim". Falha alto em vez de reportar um total incompleto.
  const totalAtEnd = await prisma.catalogProduct.count({ where: { shop: SHOP } });
  if (processed !== totalAtEnd) {
    throw new Error(
      `paginação incompleta: processados=${processed}, catálogo agora=${totalAtEnd} (era ${total} ao início) — corre outra vez`
    );
  }

  console.log(`\nprocessados: ${processed}  ·  cleanTitle ≠ title: ${changed}`);
  console.log(`\n── alteradas por regra ──`);
  for (const [rule, count] of [...ruleCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(6)}  ${rule}`);
  }
}

async function main() {
  if (EXECUTE) await execute();
  else if (TARGETED) await runTargeted();
  else if (RANDOM_N) await runRandomRate(RANDOM_N);
  else await dryRunSample();
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err?.stack || err?.message || err);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
