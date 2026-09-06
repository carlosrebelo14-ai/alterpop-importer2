#!/usr/bin/env node
/**
 * REPORT MODE — corre o franchiseResolver sobre o catálogo e imprime quantos produtos
 * resolve por universo, sem escrever NADA (nem metafields, nem BD, nem Shopify).
 *
 * Serve para validar as contagens da tabela dos 40 universos ANTES de tocar em dados
 * (Portão A do plano). É o passo 4 de docs/PLANO-normalizacao-franquias.md.
 *
 * Fonte dos dados:
 *   default (--from-csv)  faz stream do CSV OcioStock (OCIOSTOCK_CSV_URL / OCIOSTOCK_CSV_PATH
 *                         no .env) e resolve em memória. Não precisa da BD nem de sessão.
 *   --from-db             lê CatalogProduct.franchiseRefs + title da BD. SÓ funciona
 *                         depois da migração da Fase 4 (a coluna não existe antes disso).
 *
 * Uso:
 *   node scripts/catalog/franchise-resolve-report.js
 *   node scripts/catalog/franchise-resolve-report.js --limit 2000
 *   node scripts/catalog/franchise-resolve-report.js --supplier-only --json
 *   node scripts/catalog/franchise-resolve-report.js --from-db --shop jyr17t-wr.myshopify.com
 */
import fs from "node:fs";
import path from "node:path";
import {
  FRANCHISE_UNIVERSES,
} from "../../lib/importer/catalog/franchiseUniverses.js";
import {
  resolveFranchise,
  checkPrecedenceInvariants,
  checkRefIndexCollisions,
} from "../../lib/importer/catalog/franchiseResolver.server.js";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valOf = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const LIMIT = parseInt(valOf("--limit", "0"), 10) || 0;
const SUPPLIER_ONLY = has("--supplier-only");
const FROM_DB = has("--from-db");
const AS_JSON = has("--json");
const SHOP = valOf("--shop", process.env.SPOT_CHECK_SHOP || "jyr17t-wr.myshopify.com");

/** Categorias que NUNCA podem sair como franquia — se aparecerem, os tokens de categoria
 *  estão a contaminar franchiseRefs (regressão da Alteração 1). */
const FORBIDDEN_AS_FRANCHISE = ["funko", "pop", "exclusive", "anime & manga", "anime and manga", "pop culture collectibles"];

function newTally() {
  const t = {
    total: 0,
    layer1: 0,
    layer2: 0,
    empty: 0,
    byUniverse: new Map(), // handle -> { name, total, layer1, layer2, samples: [] }
    forbidden: [],         // { sku, title, franchise }
    mandalorianInStarWars: [], // sanity: precedência
    emptySamples: [],
  };
  for (const u of FRANCHISE_UNIVERSES) {
    t.byUniverse.set(u.handle, { name: u.name, handle: u.handle, active: u.active, estRange: u.estRange, total: 0, layer1: 0, layer2: 0, samples: [] });
  }
  return t;
}

function record(t, product) {
  t.total += 1;
  const res = resolveFranchise(product, {
    titleLayerOnlyForSupplierTitles: SUPPLIER_ONLY,
    titleSource: product.titleSource,
  });

  if (res.layer === 3 || !res.handle) {
    t.empty += 1;
    if (t.emptySamples.length < 40) {
      t.emptySamples.push({ sku: product.sku, title: product.title, refs: product.franchiseRefs || [] });
    }
    return;
  }

  if (res.layer === 1) t.layer1 += 1;
  else t.layer2 += 1;

  const bucket = t.byUniverse.get(res.handle);
  bucket.total += 1;
  if (res.layer === 1) bucket.layer1 += 1;
  else bucket.layer2 += 1;
  if (bucket.samples.length < 12) {
    bucket.samples.push({ sku: product.sku, title: product.title, layer: res.layer, matchedOn: res.matchedOn });
  }

  const fLower = String(res.franchise).toLowerCase();
  if (FORBIDDEN_AS_FRANCHISE.includes(fLower)) {
    t.forbidden.push({ sku: product.sku, title: product.title, franchise: res.franchise });
  }
  if (res.handle === "star-wars") {
    const tl = String(product.title || "").toLowerCase();
    if (/(mandalorian|grogu|ahsoka)/.test(tl)) {
      t.mandalorianInStarWars.push({ sku: product.sku, title: product.title });
    }
  }
}

async function loadFromCsv(t) {
  const { streamOcioStockRows, mapOcioStockRow } = await import(
    "../../lib/importer/connectors/ociostock/index.js"
  );
  let stop = false;
  await streamOcioStockRows({
    shouldStop: () => stop,
    onRow: (row) => {
      const rec = mapOcioStockRow(row);
      if (!rec) return;
      record(t, rec);
      if (LIMIT && t.total >= LIMIT) stop = true;
    },
  });
}

async function loadFromDb(t) {
  const { prisma } = await import("../../lib/prisma/prismaSafe.server.js");
  const PAGE = 1000;
  let cursor = null;
  for (;;) {
    const rows = await prisma.catalogProduct.findMany({
      where: { shop: SHOP },
      select: { sku: true, title: true, franchises: true, franchiseRefs: true, titleSource: true },
      orderBy: { sku: "asc" },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { shop_sku: { shop: SHOP, sku: cursor } } } : {}),
    });
    if (!rows.length) break;
    for (const r of rows) {
      let franchiseRefs = [];
      try { franchiseRefs = JSON.parse(r.franchiseRefs || "[]"); } catch { /* */ }
      record(t, { sku: r.sku, title: r.title, franchiseRefs, titleSource: r.titleSource });
      if (LIMIT && t.total >= LIMIT) return;
    }
    cursor = rows[rows.length - 1].sku;
    if (rows.length < PAGE) break;
  }
}

function pct(n, d) {
  return d ? `${((n / d) * 100).toFixed(1)}%` : "—";
}

function printReport(t) {
  const rows = [...t.byUniverse.values()].sort((a, b) => b.total - a.total);

  console.log("\n=== Franchise resolve report ===");
  console.log(`fonte: ${FROM_DB ? `BD (${SHOP})` : "CSV stream"}${LIMIT ? ` · limit ${LIMIT}` : ""}${SUPPLIER_ONLY ? " · camada 2 só p/ titleSource=supplier" : ""}`);
  console.log(`produtos analisados: ${t.total}`);
  console.log(`resolvidos: ${t.total - t.empty} (${pct(t.total - t.empty, t.total)})  ·  camada 1: ${t.layer1}  ·  camada 2: ${t.layer2}  ·  vazio: ${t.empty} (${pct(t.empty, t.total)})`);

  console.log("\n-- por universo (ordenado por nº resolvido) --");
  const pad = (s, n) => String(s).padEnd(n);
  const lpad = (s, n) => String(s).padStart(n);
  console.log(`${pad("universo", 26)} ${lpad("estRange", 12)} ${lpad("resolv", 7)} ${lpad("L1", 6)} ${lpad("L2", 6)}  range?`);
  for (const r of rows) {
    const [lo, hi] = r.estRange;
    const within = r.total >= lo && r.total <= hi ? "ok" : r.total < lo ? `-${lo - r.total}` : `+${r.total - hi}`;
    const flag = !r.active && r.total >= 10 ? "  ⇧ passou dormente→ativo" : r.active && r.total <= 1 ? "  ⇩ ativo mas ≤1" : r.total === 0 ? "  (0)" : "";
    console.log(`${pad(r.name, 26)} ${lpad(`${lo}-${hi}`, 12)} ${lpad(r.total, 7)} ${lpad(r.layer1, 6)} ${lpad(r.layer2, 6)}  ${within}${flag}`);
  }

  console.log("\n-- alertas de sanidade --");
  const cfgPrec = checkPrecedenceInvariants();
  const cfgRefs = checkRefIndexCollisions();
  if (cfgPrec.length) cfgPrec.forEach((p) => console.log(`  [config] ${p}`));
  if (cfgRefs.length) cfgRefs.forEach((p) => console.log(`  [config] ${p}`));
  if (!cfgPrec.length && !cfgRefs.length) console.log("  config da tabela: ok (precedência + refs sem colisão)");

  if (t.forbidden.length) {
    console.log(`  ✗ ERRO: ${t.forbidden.length} produto(s) receberam categoria como franquia (Funko/Pop/…). Amostra:`);
    t.forbidden.slice(0, 10).forEach((f) => console.log(`      ${f.sku}  "${f.title}" → ${f.franchise}`));
  } else {
    console.log("  ✓ nenhum produto recebeu Funko/Pop/Exclusive/Anime & Manga como franquia");
  }

  if (t.mandalorianInStarWars.length) {
    console.log(`  ✗ ${t.mandalorianInStarWars.length} produto(s) Mandalorian/Grogu/Ahsoka caíram em Star Wars (precedência falhou). Amostra:`);
    t.mandalorianInStarWars.slice(0, 8).forEach((f) => console.log(`      ${f.sku}  "${f.title}"`));
  } else {
    console.log("  ✓ nenhum produto Mandalorian/Grogu/Ahsoka caiu em Star Wars");
  }

  const onePiece = t.byUniverse.get("one-piece").total;
  const stitch = t.byUniverse.get("stitch").total;
  const outOfBand = (v, [lo, hi]) => v < lo * 0.75 || v > hi * 1.25;
  if (outOfBand(onePiece, [379, 379])) console.log(`  ⚠ One Piece resolveu ${onePiece} (esperado ~379)`);
  if (outOfBand(stitch, [105, 105])) console.log(`  ⚠ Stitch resolveu ${stitch} (esperado ~105)`);
  const zeros = rows.filter((r) => r.active && r.total === 0);
  if (zeros.length) console.log(`  ⚠ universos ativos com 0 resolvidos: ${zeros.map((z) => z.name).join(", ")}`);

  const active = rows.filter((r) => r.total >= 10).length;
  console.log(`\n-- resumo coleções --`);
  console.log(`  universos que cruzariam o limiar de 10: ${active}  (tabela prevê 30 ativos)`);

  console.log("\n-- amostra de vazios (30) --");
  t.emptySamples.slice(0, 30).forEach((e) => console.log(`  ${e.sku}  "${e.title}"  refs=[${e.refs.join(", ")}]`));
}

function writeJson(t) {
  const outDir = path.join(process.cwd(), "results");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(outDir, `franchise-report-${stamp}.json`);
  const payload = {
    generatedAt: new Date().toISOString(),
    source: FROM_DB ? `db:${SHOP}` : "csv",
    limit: LIMIT || null,
    supplierOnly: SUPPLIER_ONLY,
    totals: { total: t.total, layer1: t.layer1, layer2: t.layer2, empty: t.empty },
    byUniverse: [...t.byUniverse.values()].map((r) => ({
      name: r.name, handle: r.handle, active: r.active, estRange: r.estRange,
      resolved: r.total, layer1: r.layer1, layer2: r.layer2, samples: r.samples,
    })),
    forbidden: t.forbidden,
    mandalorianInStarWars: t.mandalorianInStarWars,
    emptySamples: t.emptySamples,
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  console.log(`\nJSON: ${path.relative(process.cwd(), file)}`);
}

async function main() {
  const t = newTally();
  if (FROM_DB) await loadFromDb(t);
  else await loadFromCsv(t);
  printReport(t);
  if (AS_JSON) writeJson(t);
  if (t.forbidden.length || t.mandalorianInStarWars.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
