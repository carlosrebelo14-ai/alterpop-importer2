#!/usr/bin/env node
/**
 * BRIEFING BACKEND · Tarefa 12 — órfãos.
 *
 * SÓ RELATÓRIO. Não escreve nada. Objetivo: identificar universos em falta na tabela
 * dos 39 antes de o lote publicado crescer — ~12 703 produtos (metade do catálogo)
 * ficam sem franquia (camada 3, vazio).
 *
 * Para cada produto CatalogProduct com resolvedFranchise NULL, tokeniza o título
 * (mesma normalização do resolver: lowercase, sem acentos, só [a-z0-9]) e conta
 * frequência de token, ignorando stopwords/ruído (unidades, cores, formatos, números
 * soltos). Imprime top 100 por frequência — cada linha é candidato a novo universo/ref
 * na tabela, não uma franquia já resolvida.
 *
 * Percorre CatalogProduct por página de cursor (memória constante — máquina Fly de
 * 512 MB, mesmo padrão do franchise-reresolve-db.js). Não usa node:sqlite (o runtime
 * de produção é Node 20, sem esse módulo).
 *
 * Correr na Fly:  node scripts/catalog/franchise-orphans-report.js
 *                 node scripts/catalog/franchise-orphans-report.js --top 200 --json
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../../lib/prisma/prismaSafe.server.js";

const args = process.argv.slice(2);
const AS_JSON = args.includes("--json");
const valOf = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const SHOP = valOf("--shop", process.env.SPOT_CHECK_SHOP || "jyr17t-wr.myshopify.com");
const TOP = parseInt(valOf("--top", "100"), 10) || 100;
const PAGE = 500;

/** Mesma normalização do resolver (franchiseResolver.server.js normText), duplicada
 *  aqui de propósito — este script só lê texto, não precisa da tabela de universos. */
function normText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Ruído que nunca é sinal de franquia: unidades, cores, formatos de embalagem, tamanhos,
 *  números soltos, conectores. Vocabulário fechado, cresce se o top 100 mostrar lixo novo. */
const STOPWORDS = new Set([
  "de", "el", "la", "los", "las", "y", "en", "con", "para", "del", "un", "una",
  "figure", "figures", "figura", "figuras", "pop", "funko", "blister", "display",
  "set", "pack", "deluxe", "assorted", "exclusive", "edition", "collection",
  "cm", "mm", "kg", "gr", "ml", "l", "xl", "xs", "s", "m",
  "mini", "big", "grande", "pequeno", "peque", "box", "keychain", "plush",
  "peluche", "surtido", "wave", "series", "serie", "vol", "the", "of",
  "and", "or", "no", "not", "new", "nuevo", "nueva",
]);

const NUMERIC_RE = /^[0-9]+$/;

async function main() {
  const totalCatalog = await prisma.catalogProduct.count({ where: { shop: SHOP } });
  const tokenCounts = new Map(); // token -> { count, skus: [] }
  let orphans = 0;
  let cursor = null;

  for (;;) {
    const rows = await prisma.catalogProduct.findMany({
      where: { shop: SHOP, resolvedFranchise: null },
      select: { sku: true, title: true },
      orderBy: [{ shop: "asc" }, { sku: "asc" }],
      take: PAGE,
      ...(cursor ? { cursor: { shop_sku: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;

    for (const r of rows) {
      orphans += 1;
      const tokens = new Set(normText(r.title).split(" ").filter(Boolean));
      for (const tok of tokens) {
        if (tok.length < 3) continue;
        if (STOPWORDS.has(tok)) continue;
        if (NUMERIC_RE.test(tok)) continue;
        let entry = tokenCounts.get(tok);
        if (!entry) {
          entry = { count: 0, skus: [] };
          tokenCounts.set(tok, entry);
        }
        entry.count += 1;
        if (entry.skus.length < 3) entry.skus.push(r.sku);
      }
    }

    cursor = { shop: SHOP, sku: rows[rows.length - 1].sku };
    if (rows.length < PAGE) break;
  }

  const top = [...tokenCounts.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, TOP);

  console.log(`\n=== franchise-orphans-report (${SHOP}) ===`);
  console.log(`catálogo total: ${totalCatalog}`);
  console.log(`sem franquia (órfãos): ${orphans} (${((orphans / totalCatalog) * 100).toFixed(1)}%)`);
  console.log(`tokens distintos (após stopwords/números): ${tokenCounts.size}`);
  console.log(`\ntop ${top.length} por frequência — candidatos a universo/ref novo na tabela:\n`);
  console.log(`  ${"freq".padStart(6)}  token              amostra de SKU`);
  for (const [tok, entry] of top) {
    console.log(`  ${String(entry.count).padStart(6)}  ${tok.padEnd(18)} ${entry.skus.join(", ")}`);
  }

  if (AS_JSON) {
    const outDir = path.join(process.cwd(), "results");
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(outDir, `franchise-orphans-report-${stamp}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          shop: SHOP,
          totalCatalog,
          orphans,
          top: top.map(([token, e]) => ({ token, count: e.count, sampleSkus: e.skus })),
        },
        null,
        2
      )
    );
    console.log(`\nJSON: ${path.relative(process.cwd(), file)}`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err?.stack || err?.message || err);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
