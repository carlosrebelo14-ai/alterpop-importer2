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
  lookupRef,
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
    degraded: false,
    layer1: 0,
    layer2: 0,
    empty: 0,
    byUniverse: new Map(), // handle -> { name, total, layer1, layer2, samples: [] }
    forbidden: [],         // { sku, title, franchise }
    mandalorianInStarWars: [], // sanity: precedência
    emptySamples: [],
    // sanity: produto com refs mas NÃO resolvido pela camada 1
    layer2WithRefs: 0,     // resolveu por título apesar de ter refs
    emptyWithRefs: 0,      // não resolveu de todo apesar de ter refs
    refShouldHaveMatched: [], // { sku, title, ref, universe } — CONTRADIÇÃO: ref na tabela mas foi p/ camada 2/3
    unmappedRefsOnMiss: new Map(), // ref cru -> count, em produtos não resolvidos pela camada 1
  };
  for (const u of FRANCHISE_UNIVERSES) {
    t.byUniverse.set(u.handle, { name: u.name, handle: u.handle, active: u.active, baseline: u.baseline, total: 0, layer1: 0, layer2: 0, samples: [] });
  }
  return t;
}

function record(t, product) {
  t.total += 1;
  const res = resolveFranchise(product, {
    titleLayerOnlyForSupplierTitles: SUPPLIER_ONLY,
    titleSource: product.titleSource,
  });

  const refs = Array.isArray(product.franchiseRefs) ? product.franchiseRefs : [];

  // Sanity: refs presentes mas a camada 1 não resolveu. Se um desses refs ESTÁ na
  // tabela, é contradição (bug do resolver). Se não está, é candidato a entrada nova.
  if (refs.length && res.layer !== 1) {
    for (const ref of refs) {
      const u = lookupRef(ref);
      if (u) {
        if (t.refShouldHaveMatched.length < 40) {
          t.refShouldHaveMatched.push({ sku: product.sku, title: product.title, ref, universe: u.name, gotLayer: res.layer });
        }
      } else {
        t.unmappedRefsOnMiss.set(ref, (t.unmappedRefsOnMiss.get(ref) || 0) + 1);
      }
    }
  }

  if (res.layer === 3 || !res.handle) {
    t.empty += 1;
    if (refs.length) t.emptyWithRefs += 1;
    if (t.emptySamples.length < 40) {
      t.emptySamples.push({ sku: product.sku, title: product.title, refs });
    }
    return;
  }

  if (res.layer === 2 && refs.length) t.layer2WithRefs += 1;

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
  let rawRows = 0;
  let mapped = 0;
  await streamOcioStockRows({
    shouldStop: () => stop,
    onRow: (row) => {
      rawRows += 1;
      const rec = mapOcioStockRow(row);
      if (!rec) return;
      mapped += 1;
      record(t, rec);
      if (LIMIT && t.total >= LIMIT) stop = true;
    },
  });
  if (mapped === 0) {
    throw new Error(
      `stream do CSV devolveu 0 produtos utilizáveis (${rawRows} linhas lidas). ` +
      `Provável: o endpoint OcioStock devolveu HTML em vez de CSV (página "GESIO muy cansado" / ` +
      `manutenção / throttle), ou o URL/token expirou. Confirma o URL num browser e tenta mais tarde. ` +
      `Alternativa: descarrega o CSV e corre com OCIOSTOCK_CSV_PATH=/caminho/para.csv`
    );
  }
}

async function loadFromDb(t) {
  // node:sqlite (Node 22.5+) — sem dependência de Prisma, funciona com qualquer schema.
  const { DatabaseSync } = await import("node:sqlite");
  const dbPath = (process.env.DATABASE_URL || "").replace(/^file:/, "") || "./dev.sqlite";
  const d = new DatabaseSync(dbPath, { readOnly: true });

  const cols = d.prepare("PRAGMA table_info(CatalogProduct)").all().map((c) => c.name);
  const hasRefs = cols.includes("franchiseRefs");
  if (!hasRefs) {
    t.degraded = true;
    console.log(
      "\n⚠ MODO DEGRADADO: a coluna CatalogProduct.franchiseRefs não existe nesta BD\n" +
      "  (pré-migração da Fase 4). A camada 1 vai receber CatalogProduct.franchises, que\n" +
      "  mistura refs do fornecedor com tokens de categoria, marcas e flags. Consequência:\n" +
      "  - as CONTAGENS por universo são aproveitáveis (o sinal do universo está lá);\n" +
      "  - o split camada 1 vs camada 2 NÃO é fiável e não valida a Fase 1.\n" +
      "  Para o split real: correr --from-csv depois do feed OcioStock voltar.\n"
    );
  }

  const sql = `SELECT sku, title, titleSource, ${hasRefs ? "franchiseRefs" : "franchises"} AS refsJson
               FROM CatalogProduct WHERE shop = ? ORDER BY sku`;
  for (const r of d.prepare(sql).all(SHOP)) {
    let refs = [];
    try { refs = JSON.parse(r.refsJson || "[]"); } catch { /* */ }
    record(t, { sku: r.sku, title: r.title, franchiseRefs: refs, titleSource: r.titleSource });
    if (LIMIT && t.total >= LIMIT) break;
  }
  d.close();
}

function pct(n, d) {
  return d ? `${((n / d) * 100).toFixed(1)}%` : "—";
}

function printReport(t) {
  const rows = [...t.byUniverse.values()].sort((a, b) => b.total - a.total);

  console.log("\n=== Franchise resolve report ===");
  console.log(`fonte: ${FROM_DB ? `BD (${SHOP})` : "CSV stream"}${t.degraded ? " · MODO DEGRADADO (refs de franchises[])" : ""}${LIMIT ? ` · limit ${LIMIT}` : ""}${SUPPLIER_ONLY ? " · camada 2 só p/ titleSource=supplier" : ""}`);
  console.log(`produtos analisados: ${t.total}`);
  const resolved = t.total - t.empty;
  console.log(`resolvidos: ${resolved} (${pct(resolved, t.total)})  ·  camada 1: ${t.layer1} (${pct(t.layer1, resolved)})  ·  camada 2: ${t.layer2} (${pct(t.layer2, resolved)})  ·  vazio: ${t.empty} (${pct(t.empty, t.total)})`);
  console.log(
    "  leitura: L1 muito > L2 é o esperado. L2 quase nulo ⇒ padrões de título fracos, franquias\n" +
    "  escondidas por apanhar (o caso LOTR). L2 alto ⇒ a separação de refs da Fase 1 não está a\n" +
    "  funcionar e a camada 1 está a perder matches que devia fazer."
  );

  console.log("\n-- por universo (ordenado por nº resolvido) --");
  const pad = (s, n) => String(s).padEnd(n);
  const lpad = (s, n) => String(s).padStart(n);
  console.log(`${pad("universo", 26)} ${lpad("baseline", 9)} ${lpad("resolv", 7)} ${lpad("Δ", 7)} ${lpad("L1", 6)} ${lpad("L2", 6)}`);
  for (const r of rows) {
    const base = r.baseline ?? 0;
    const d = r.total - base;
    const dpct = base ? ` ${d >= 0 ? "+" : ""}${((d / base) * 100).toFixed(0)}%` : "";
    const delta = `${d >= 0 ? "+" : ""}${d}${dpct}`;
    const big = base >= 20 && Math.abs(d) / base > 0.15 ? "  ⚠ desvio" : "";
    const flag = !r.active && r.total >= 10 ? "  ⇧ dormente→ativo" : r.active && r.total <= 1 ? "  ⇩ ativo mas ≤1" : r.total === 0 ? "  (0)" : "";
    console.log(`${pad(r.name, 26)} ${lpad(base, 9)} ${lpad(r.total, 7)} ${lpad(delta, 12)} ${lpad(r.layer1, 6)} ${lpad(r.layer2, 6)}${big}${flag}`);
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

  const drift = rows.filter((r) => (r.baseline ?? 0) >= 20 && Math.abs(r.total - r.baseline) / r.baseline > 0.15);
  if (drift.length) {
    console.log(`  ⚠ ${drift.length} universo(s) com desvio > 15% face à baseline (ver coluna Δ) — feed mudou ou a tabela regrediu:`);
    drift.forEach((r) => console.log(`      ${r.name}: ${r.total} vs baseline ${r.baseline}`));
  } else {
    console.log("  ✓ nenhum universo com desvio > 15% face à baseline");
  }
  const zeros = rows.filter((r) => r.active && r.total === 0);
  if (zeros.length) console.log(`  ⚠ universos ativos com 0 resolvidos: ${zeros.map((z) => z.name).join(", ")}`);

  // Camada 1 a falhar matches que devia fazer — bug silencioso (o resultado final até
  // fica certo, mas via camada 2). O rácio abaixo é o sinal mais informativo do report.
  if (t.refShouldHaveMatched.length) {
    console.log(`  ✗ ERRO: ${t.refShouldHaveMatched.length} produto(s) tinham um ref QUE ESTÁ na tabela mas foram resolvidos pela camada ${"2/3"} — contradição no resolver. Amostra:`);
    t.refShouldHaveMatched.slice(0, 10).forEach((x) => console.log(`      ${x.sku}  ref="${x.ref}" (→ ${x.universe})  got L${x.gotLayer}  "${x.title}"`));
  }
  const l2Ratio = t.layer2 ? t.layer2WithRefs / t.layer2 : 0;
  if (t.layer2WithRefs) {
    const sev = l2Ratio > 0.05 ? "⚠" : "·";
    console.log(`  ${sev} ${t.layer2WithRefs} produto(s) resolvidos pela camada 2 TINHAM refs (${pct(t.layer2WithRefs, t.layer2)} da camada 2). ${t.emptyWithRefs} vazios também tinham refs.`);
    console.log(`      Se relevante: a camada 1 está a perder match — normalmente ref do feed com grafia que a tabela não prevê.`);
  } else {
    console.log("  ✓ nenhum produto resolvido pela camada 2 tinha refs (camada 1 não está a perder matches)");
  }
  if (t.unmappedRefsOnMiss.size) {
    const top = [...t.unmappedRefsOnMiss.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
    console.log(`  refs em produtos NÃO resolvidos pela camada 1, sem entrada na tabela (top 25 — candidatos a rever):`);
    top.forEach(([ref, n]) => console.log(`      ${String(n).padStart(5)}  ${ref}`));
  }

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
    totals: {
      total: t.total, layer1: t.layer1, layer2: t.layer2, empty: t.empty,
      layer2WithRefs: t.layer2WithRefs, emptyWithRefs: t.emptyWithRefs,
    },
    byUniverse: [...t.byUniverse.values()].map((r) => ({
      name: r.name, handle: r.handle, active: r.active, baseline: r.baseline,
      resolved: r.total, layer1: r.layer1, layer2: r.layer2, samples: r.samples,
    })),
    forbidden: t.forbidden,
    mandalorianInStarWars: t.mandalorianInStarWars,
    refShouldHaveMatched: t.refShouldHaveMatched,
    unmappedRefsOnMiss: [...t.unmappedRefsOnMiss.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([ref, count]) => ({ ref, count })),
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
  if (t.forbidden.length || t.mandalorianInStarWars.length || t.refShouldHaveMatched.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
