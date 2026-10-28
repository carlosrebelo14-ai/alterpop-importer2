#!/usr/bin/env node
/**
 * Pipeline de vocabulário (28/10/2026) — candidatos a personagem por universo, para as franquias
 * abertas. Só leitura. Não escreve nada e não usa API de AI.
 *
 * Por universo: nome candidato (lib/importer/catalog/characterCandidates.js), contagem na piscina de
 * coleccionáveis, contagem nos ACTIVE, até 3 títulos de exemplo, e a marca "já no vocabulário" ou "novo".
 * Saída com colunas separadas por tab (SKU pode ter espaço).
 *
 * Correr na Fly:  node scripts/catalog/character-candidates.js
 * Sem limite de linhas por universo (ronda 1, 28/10/2026).
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { FRANCHISE_UNIVERSES } from "../../lib/importer/catalog/franchiseUniverses.js";
import { CHARACTER_VOCABULARY, CHARACTER_ALIASES } from "../../lib/importer/catalog/characterVocabulary.js";
import { isCollectibleVendor } from "../../lib/importer/catalog/manufacturerTierResolver.server.js";
import { extractCandidateName } from "../../lib/importer/catalog/characterCandidates.js";
import { fetchActiveProducts } from "../../lib/importer/shopify/characterPagesSync.server.js";

const args = process.argv.slice(2);
const valOf = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const SHOP = valOf("--shop", process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com");
const EXEMPLOS = 3;

// Uma linha por candidato, colunas com tab: universo, nome, piscina, ACTIVE, estado, 3 títulos.
const norm = (s) => String(s ?? "").normalize("NFC").toLowerCase().trim();

function jaNoVocabulario(universoNome, candidato) {
  const entry = CHARACTER_VOCABULARY.find((e) => e.universo === universoNome);
  if (!entry) return false;
  const alvo = norm(candidato);
  return entry.nomes.some((nome) => {
    const todos = [nome, ...(CHARACTER_ALIASES[nome] || [])];
    return todos.some((x) => norm(x) === alvo);
  });
}

async function main() {
  console.log(`\n=== character-candidates (${SHOP}) · só leitura ===\n`);
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);
  const activeSkus = new Set((await fetchActiveProducts(client)).map((p) => p.sku));

  const universos = FRANCHISE_UNIVERSES.filter((u) => u.active && u.status === "open");
  const nomes = universos.map((u) => u.name);
  const rows = await prisma.catalogProduct.findMany({
    where: { shop: SHOP, resolvedFranchise: { in: nomes } },
    select: { sku: true, originalTitle: true, titleOverride: true, vendor: true, resolvedFranchise: true },
  });
  const piscina = rows.filter((r) => isCollectibleVendor(r.vendor));
  console.log(`piscina de coleccionáveis: ${piscina.length} · ACTIVE na loja: ${activeSkus.size}\n`);

  for (const u of universos) {
    const deste = piscina.filter((r) => r.resolvedFranchise === u.name);
    if (!deste.length) continue;
    const padroes = u.titlePatterns || [];
    const porNome = new Map();
    for (const r of deste) {
      const titulo = r.titleOverride ?? r.originalTitle ?? "";
      const candidato = extractCandidateName(titulo, { franchisePatterns: padroes, vendor: r.vendor });
      if (!candidato) continue;
      if (!porNome.has(candidato)) porNome.set(candidato, { total: 0, active: 0, exemplos: [] });
      const e = porNome.get(candidato);
      e.total += 1;
      if (activeSkus.has(r.sku)) e.active += 1;
      if (e.exemplos.length < EXEMPLOS) e.exemplos.push(titulo);
    }
    const ordenados = [...porNome.entries()].sort((a, b) => b[1].total - a[1].total);
    const comVocab = CHARACTER_VOCABULARY.some((e) => e.universo === u.name);
    console.log(`# ${u.name}\tpiscina ${deste.length}\t${comVocab ? "vocabulário existe" : "sem vocabulário"}`);
    for (const [nome, e] of ordenados) {
      const estado = jaNoVocabulario(u.name, nome) ? "vocabulário" : "novo";
      const exemplos = [0, 1, 2].map((i) => e.exemplos[i] ?? "");
      console.log([u.name, nome, e.total, e.active, estado, ...exemplos].join("\t"));
    }
  }
  console.log("(nada escrito — só leitura.)");
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
