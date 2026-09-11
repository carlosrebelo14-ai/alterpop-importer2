#!/usr/bin/env node
/**
 * BRIEFING BACKEND · Tarefa 17 — perfil dos sem sinal. Alimenta/fecha a Decisão 10.
 *
 * SÓ RELATÓRIO. Amostra ALEATÓRIA de 100 dos órfãos (resolvedFranchise NULL), com
 * título completo e refs. Não classifica sozinho — imprime tudo o que é preciso para
 * um humano (ou uma leitura seguinte) baldear em:
 *
 *   A) licença presente mas não reconhecida  (há ref/marca identificável, falta tabela)
 *   B) licença ausente                        (stock genérico, sem IP — a hipótese da
 *                                               Decisão 10: mochilas, puzzles, papelaria)
 *   C) ambíguo                                 (não dá para decidir só pelo título/ref)
 *
 * Heurística de apoio (NÃO decide sozinha): sinaliza como candidato a B quando o
 * título só tem palavras de categoria genérica (backpack, puzzle, mug, case, …) e a
 * lista de refs não contém nada que pareça nome próprio/marca.
 *
 * Correr na Fly:  node scripts/catalog/franchise-orphans-profile.js
 *                 node scripts/catalog/franchise-orphans-profile.js --json
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
const SHOP = valOf("--shop", process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com");
const N = parseInt(valOf("--n", "100"), 10) || 100;
const PAGE = 500;

/** Categorias genéricas de produto — presença SOZINHA (sem outro sinal) sugere B. */
const GENERIC_WORDS = new Set([
  "backpack", "puzzle", "mug", "case", "bottle", "bag", "pencil", "notebook",
  "keychain", "wallet", "purse", "cup", "plate", "bowl", "umbrella", "towel",
  "blanket", "pillow", "cushion", "socks", "cap", "hat", "scarf", "gloves",
  "lamp", "clock", "calendar", "sticker", "poster", "frame", "tray", "box",
  "lunchbox", "thermos", "flask", "speaker", "headphones", "earpods", "watch",
  "chair", "trolley", "umbrella", "raincoat", "apron",
]);

function parseRefs(raw) {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function normWords(title) {
  return String(title || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** Heurística de apoio — não é veredicto. */
function suggestBucket(title, refs) {
  const words = normWords(title);
  const meaningful = words.filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w) && !/^\d+$/.test(w) && !/^\d+(cm|mm|kg|ml)$/.test(w));
  const hasBrandyRef = refs.some((r) => !/^(assorted|deluxe|set|blister|offer|clearance|ofertas|xoff|xon)$/i.test(r));
  if (!meaningful.length && !hasBrandyRef) return "B (sugerido)";
  if (meaningful.length >= 1 || hasBrandyRef) return "A (sugerido) — tem sinal, falta na tabela";
  return "C (sugerido) — ambíguo";
}

async function fetchAllOrphanSkus() {
  const out = [];
  let cursor = null;
  for (;;) {
    const rows = await prisma.catalogProduct.findMany({
      where: { shop: SHOP, resolvedFranchise: null },
      select: { sku: true },
      orderBy: [{ shop: "asc" }, { sku: "asc" }],
      take: PAGE,
      ...(cursor ? { cursor: { shop_sku: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    out.push(...rows.map((r) => r.sku));
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

async function main() {
  const allSkus = await fetchAllOrphanSkus();
  const sampleSkus = shuffleSample(allSkus, Math.min(N, allSkus.length));

  const rows = await prisma.catalogProduct.findMany({
    where: { shop: SHOP, sku: { in: sampleSkus } },
    select: { sku: true, title: true, franchiseRefs: true, vendor: true },
  });

  const items = rows.map((r) => {
    const refs = parseRefs(r.franchiseRefs);
    return { sku: r.sku, title: r.title, vendor: r.vendor, refs, suggested: suggestBucket(r.title, refs) };
  });

  const counts = { A: 0, B: 0, C: 0 };
  for (const it of items) {
    if (it.suggested.startsWith("A")) counts.A += 1;
    else if (it.suggested.startsWith("B")) counts.B += 1;
    else counts.C += 1;
  }

  console.log(`\n=== franchise-orphans-profile (${SHOP}) — Tarefa 17 ===\n`);
  console.log(`total de órfãos no catálogo: ${allSkus.length}`);
  console.log(`amostra aleatória: ${items.length}\n`);
  console.log(`sugestão automática (heurística, NÃO é veredicto):`);
  console.log(`  A — licença presente, não reconhecida: ${counts.A} (${((counts.A / items.length) * 100).toFixed(0)}%)`);
  console.log(`  B — licença ausente (stock genérico):  ${counts.B} (${((counts.B / items.length) * 100).toFixed(0)}%)`);
  console.log(`  C — ambíguo:                            ${counts.C} (${((counts.C / items.length) * 100).toFixed(0)}%)\n`);

  console.log(`── amostra completa (título + refs, para classificação humana) ──\n`);
  for (const it of items) {
    console.log(`  ${it.sku}  [${it.suggested}]`);
    console.log(`    título: "${it.title}"`);
    console.log(`    vendor: ${it.vendor || "∅"}  refs: ${JSON.stringify(it.refs)}`);
  }

  if (AS_JSON) {
    const outDir = path.join(process.cwd(), "results");
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(outDir, `franchise-orphans-profile-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify({ shop: SHOP, totalOrphans: allSkus.length, sample: items, counts }, null, 2));
    console.log(`\nJSON: ${path.relative(process.cwd(), file)}`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err?.stack || err?.message || err);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
