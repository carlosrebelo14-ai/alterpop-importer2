#!/usr/bin/env node
/**
 * Tarefa 47 (Decisão 25) — censo de "ref legítimo, licença inexistente".
 *
 * Classe de risco nova, achada na revisão do lote piloto: o feed OcioStock marca
 * produtos com `ref=` de universo licenciado mesmo quando o produto é de uma marca
 * genérica ("inspirado em", sem licença real) — ex.: 0035051531166, MGA
 * Entertainment/Miniverse com ref "HARRY POTTER" literal, título e ref concordam,
 * fora do critério da Tarefa 11 (que só apanha DISCORDÂNCIA título/ref).
 *
 * SÓ RELATÓRIO — read-only. Não decide deny-list de marcas; isso fica para a revisão
 * humana do censo, pós-inauguração (Decisão 25).
 *
 * Correr na Fly:  node scripts/catalog/franchise-brand-overlap-audit.js
 *                 node scripts/catalog/franchise-brand-overlap-audit.js --json
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../../lib/prisma/prismaSafe.server.js";

const args = process.argv.slice(2);
const AS_JSON = args.includes("--json");
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";
const PAGE = 500;
const SAMPLES_PER_BRAND = 5;

/** Marcas de fabricante genéricas — não são licenças, o feed usa-as como ref extra
 *  ao lado do universo. Ver Decisão 25. */
const GENERIC_BRAND_REFS = ["mga", "miniverse", "bandai", "jada", "zuru", "clearance"];

function parseJsonArray(jsonField) {
  try {
    const parsed = JSON.parse(String(jsonField || "[]"));
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function main() {
  console.log(`\n=== franchise-brand-overlap-audit (${SHOP}) — Tarefa 47 (Decisão 25) ===\n`);

  // marca -> { count, universes: Map<universo, count>, samples: [] }
  const byBrand = new Map();
  let scanned = 0;
  let layer1Checked = 0;
  let cursor = null;

  for (;;) {
    const rows = await prisma.catalogProduct.findMany({
      where: { shop: SHOP, resolvedFranchiseLayer: 1 },
      select: { sku: true, title: true, resolvedFranchise: true, franchiseRefs: true },
      orderBy: [{ shop: "asc" }, { sku: "asc" }],
      take: PAGE,
      ...(cursor ? { cursor: { shop_sku: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;

    for (const r of rows) {
      scanned += 1;
      layer1Checked += 1;
      const refs = parseJsonArray(r.franchiseRefs).map((v) => String(v).toLowerCase());

      for (const brand of GENERIC_BRAND_REFS) {
        if (!refs.includes(brand)) continue;
        // "franchiseRefs contém universo licenciado" — resolvedFranchise já É o
        // universo que a camada 1 resolveu a partir de algum ref nesta mesma lista,
        // então a presença simultânea da marca genérica é, por definição, a
        // sobreposição que queremos censar.
        let entry = byBrand.get(brand);
        if (!entry) {
          entry = { count: 0, universes: new Map(), samples: [] };
          byBrand.set(brand, entry);
        }
        entry.count += 1;
        entry.universes.set(r.resolvedFranchise, (entry.universes.get(r.resolvedFranchise) || 0) + 1);
        if (entry.samples.length < SAMPLES_PER_BRAND) {
          entry.samples.push({ sku: r.sku, title: r.title, universo: r.resolvedFranchise, refs });
        }
        break; // um produto conta uma vez por marca disparadora; não duplica por SKU se tiver 2 marcas genéricas — cada uma tem a sua entrada própria
      }
    }

    cursor = { shop: SHOP, sku: rows[rows.length - 1].sku };
    if (rows.length < PAGE) break;
  }

  console.log(`produtos camada 1 analisados: ${layer1Checked}`);
  console.log(`marcas disparadoras: ${byBrand.size}\n`);

  const rows2 = [];
  for (const [brand, entry] of byBrand.entries()) {
    for (const [universo, count] of entry.universes.entries()) {
      rows2.push({ brand, universo, count });
    }
  }
  rows2.sort((a, b) => b.count - a.count || a.brand.localeCompare(b.brand));

  console.log(`  ${"contagem".padStart(8)}  marca → universo`);
  for (const r of rows2) {
    console.log(`  ${String(r.count).padStart(8)}  "${r.brand}" → ${r.universo}`);
  }

  console.log(`\n── amostra por marca (${SAMPLES_PER_BRAND} por marca) ──`);
  const sortedBrands = [...byBrand.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [brand, entry] of sortedBrands) {
    console.log(`\n  "${brand}" (${entry.count} produtos, ${entry.universes.size} universo(s)):`);
    entry.samples.forEach((s) =>
      console.log(`    ${s.sku}  → ${s.universo}  refs=${JSON.stringify(s.refs)}  "${s.title.slice(0, 60)}"`)
    );
  }

  if (!byBrand.size) {
    console.log(`  ✓ nenhuma sobreposição marca-genérica/universo-licenciado encontrada.`);
  }

  console.log(`\n(nada escrito — só relatório. Decisão sobre deny-list fica para pós-inauguração.)`);

  if (AS_JSON) {
    const outDir = path.join(process.cwd(), "results");
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(outDir, `franchise-brand-overlap-audit-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify({ shop: SHOP, layer1Checked, brands: rows2 }, null, 2));
    console.log(`\nJSON: ${path.relative(process.cwd(), file)}`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err?.stack || err?.message || err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
