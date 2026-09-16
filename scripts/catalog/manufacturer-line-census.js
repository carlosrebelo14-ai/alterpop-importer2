#!/usr/bin/env node
/**
 * B6 (briefing backend 16/09/2026) — censo exploratório para `alterpop.manufacturer_line`.
 *
 * A Banpresto (1 940 produtos, ver B3) tem linhas reconhecíveis no título — Ichibansho,
 * Mystical Adventure, Duel Memories são os três exemplos dados no briefing. Este script
 * lista os títulos (cleanTitle quando existe) para se poder ler o vocabulário real de
 * linhas antes de fechar o vocabulário fechado do resolver (mesmo espírito do
 * formatExtractor.server.js — Tarefa 34).
 *
 * SÓ LEITURA. Vendor por --vendor (default Banpresto).
 *
 * Correr: node scripts/catalog/manufacturer-line-census.js [--vendor Banpresto] [--sample 200]
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { FRANCHISE_UNIVERSES } from "../../lib/importer/catalog/franchiseUniverses.js";

/** Ruído a excluir do ranking de frases: nomes de universo (já cobertos pelo
 *  franchiseResolver, não são linha de fabricante) + palavras genéricas comuns em
 *  título de anime/manga que não identificam uma linha de produto. */
const FRANCHISE_NOISE = new Set(
  FRANCHISE_UNIVERSES.flatMap((u) => [u.name, ...(u.titlePatterns || [])]).map((s) =>
    s.toLowerCase()
  )
);
function isFranchiseNoise(phrase) {
  const low = phrase.toLowerCase();
  for (const noise of FRANCHISE_NOISE) {
    if (low === noise || low.startsWith(noise + " ") || low.includes(" " + noise)) return true;
  }
  return false;
}

const args = process.argv.slice(2);
const valOf = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const VENDOR = valOf("--vendor", "Banpresto");
const SAMPLE = parseInt(valOf("--sample", "200"), 10);
const SHOP = process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com";

async function main() {
  const rows = await prisma.catalogProduct.findMany({
    where: { shop: SHOP, vendorNorm: { contains: VENDOR.toLowerCase() } },
    select: { sku: true, title: true, cleanTitle: true },
  });

  console.log(`[manufacturer-line-census] vendor="${VENDOR}" total=${rows.length}`);

  // Frequência de bigramas/trigramas capitalizados (candidatos a nome de linha) —
  // heurística só para leitura humana, não gera o vocabulário fechado sozinha.
  const phraseFreq = new Map();
  const CAP_PHRASE_RE = /\b([A-Z][a-zA-Z0-9']*(?:\s[A-Z][a-zA-Z0-9']*){0,2})\b/g;

  for (const row of rows) {
    const title = String(row.cleanTitle || row.title || "");
    let m;
    CAP_PHRASE_RE.lastIndex = 0;
    while ((m = CAP_PHRASE_RE.exec(title))) {
      const phrase = m[1].trim();
      if (phrase.length < 4) continue;
      if (/^(The|And|For|With|Set|Vol|No)\b/i.test(phrase)) continue;
      phraseFreq.set(phrase, (phraseFreq.get(phrase) || 0) + 1);
    }
  }

  const ranked = Array.from(phraseFreq.entries())
    .filter(([phrase, n]) => n >= 4 && !isFranchiseNoise(phrase))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 60);

  console.log(`\n[manufacturer-line-census] frases capitalizadas (>=4 ocorrências, sem ruído de franquia, candidatas a linha):`);
  for (const [phrase, n] of ranked) {
    console.log(`  ${n}\t${phrase}`);
  }

  const briefingExamples = ["Ichibansho", "Mystical Adventure", "Duel Memories"];
  console.log(`\n[manufacturer-line-census] contagem exata dos exemplos do briefing:`);
  for (const ex of briefingExamples) {
    const n = rows.filter((r) => (r.cleanTitle || r.title || "").includes(ex)).length;
    console.log(`  ${n}\t${ex}`);
  }

  console.log(`\n[manufacturer-line-census] amostra de ${Math.min(SAMPLE, rows.length)} títulos:`);
  for (const row of rows.slice(0, SAMPLE)) {
    console.log(`  ${row.sku}\t${row.cleanTitle || row.title}`);
  }
}

main()
  .catch((err) => {
    console.error("[manufacturer-line-census] fatal:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
