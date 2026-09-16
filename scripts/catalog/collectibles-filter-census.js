#!/usr/bin/env node
/**
 * Briefing backend 15/09/2026 · as duas contagens pedidas ANTES de gerar os 34 CSV —
 * resolve a tensão entre "34 universos abertos" e "filtro de coleccionáveis" (só
 * COLLECTOR/CORE, manufacturerTierResolver.server.js).
 *
 *   1. Quais dos 15 nomes COLLECTOR e CORE existem no feed, com contagem — define a
 *      piscina real de curadoria.
 *   2. Produtos por universo (os 34 ativos) DEPOIS do filtro de coleccionáveis — mostra
 *      se algum universo fica em osso (poucos produtos sobrevivem ao filtro).
 *
 * SÓ LEITURA. Não escreve nada. Paginação por cursor (padrão Tarefa 17). Qualquer falha
 * de leitura aborta com exit != 0 (Decisão 30).
 *
 * Correr:  node scripts/catalog/collectibles-filter-census.js
 *          node scripts/catalog/collectibles-filter-census.js --osso 20
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { MANUFACTURER_TIERS } from "../../lib/importer/catalog/manufacturerTiers.js";
import { isCollectibleVendor } from "../../lib/importer/catalog/manufacturerTierResolver.server.js";
import { FRANCHISE_UNIVERSES } from "../../lib/importer/catalog/franchiseUniverses.js";

const args = process.argv.slice(2);
const valOf = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const SHOP = valOf("--shop", process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com");
const LIMIAR_OSSO = parseInt(valOf("--osso", "20"), 10) || 20;
const PAGE = 500;

const COLLECTOR_CORE = MANUFACTURER_TIERS.filter((m) => m.tier === "COLLECTOR" || m.tier === "CORE");

function normalizeForMatch(label) {
  return String(label || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join("");
}

async function main() {
  const total = await prisma.catalogProduct.count({ where: { shop: SHOP } });
  console.log(`\n=== collectibles-filter-census (${SHOP}) — briefing backend, pré-B1 ===\n`);
  console.log(`CatalogProduct: ${total}\n`);

  const porVendorNorm = new Map(); // norm -> { vendor, count }
  const porUniversoTotal = new Map(); // universo -> total (sem filtro)
  const porUniversoFiltrado = new Map(); // universo -> total (com filtro)
  let semFranquia = 0;
  let filtradoSemFranquia = 0;

  let lidos = 0;
  let cursor = null;
  for (;;) {
    let rows;
    try {
      rows = await prisma.catalogProduct.findMany({
        where: { shop: SHOP },
        select: { sku: true, vendor: true, resolvedFranchise: true },
        orderBy: [{ shop: "asc" }, { sku: "asc" }],
        take: PAGE,
        ...(cursor ? { cursor: { shop_sku: cursor }, skip: 1 } : {}),
      });
    } catch (err) {
      throw new Error(`FALHA DE LEITURA (CatalogProduct): ${err?.message || err}`);
    }
    if (!rows.length) break;

    for (const r of rows) {
      lidos += 1;
      const vendor = (r.vendor || "").trim() || "(sem fabricante)";
      const norm = normalizeForMatch(vendor);
      if (!porVendorNorm.has(norm)) porVendorNorm.set(norm, { vendor, count: 0 });
      porVendorNorm.get(norm).count += 1;

      if (r.resolvedFranchise) {
        porUniversoTotal.set(r.resolvedFranchise, (porUniversoTotal.get(r.resolvedFranchise) || 0) + 1);
      } else {
        semFranquia += 1;
      }

      if (isCollectibleVendor(vendor)) {
        if (r.resolvedFranchise) {
          porUniversoFiltrado.set(r.resolvedFranchise, (porUniversoFiltrado.get(r.resolvedFranchise) || 0) + 1);
        } else {
          filtradoSemFranquia += 1;
        }
      }
    }

    cursor = { shop: SHOP, sku: rows[rows.length - 1].sku };
    if (rows.length < PAGE) break;
  }

  // ---------------------------------------------------------------------------------
  console.log(`## 1. COLLECTOR + CORE NO FEED (a piscina real de curadoria)\n`);
  let piscinaTotal = 0;
  const ordemTier = ["COLLECTOR", "CORE"];
  for (const tier of ordemTier) {
    console.log(`  ${tier}:`);
    for (const m of COLLECTOR_CORE.filter((c) => c.tier === tier)) {
      const norm = normalizeForMatch(m.name);
      const achado = porVendorNorm.get(norm);
      const count = achado?.count || 0;
      piscinaTotal += count;
      console.log(`      ${String(count).padStart(6)}  ${m.name}${achado ? "" : "  (ausente do feed)"}`);
    }
  }
  console.log(`\n  Piscina real de curadoria (só COLLECTOR+CORE presentes): ${piscinaTotal} produtos`);
  console.log(`  (ARTISAN e SIGNATURE ficam fora do filtro por desenho — ver manufacturerTierResolver.server.js)\n`);

  // ---------------------------------------------------------------------------------
  console.log(`\n## 2. PRODUTOS POR UNIVERSO, ANTES E DEPOIS DO FILTRO (34 ativos)\n`);
  console.log(`${"Universo".padEnd(28)}${"Antes".padStart(8)}${"Depois".padStart(8)}${"%".padStart(7)}`);
  const universosAtivos = FRANCHISE_UNIVERSES.filter((u) => u.active);
  const linhas = universosAtivos
    .map((u) => {
      const antes = porUniversoTotal.get(u.name) || 0;
      const depois = porUniversoFiltrado.get(u.name) || 0;
      const pct = antes ? ((depois / antes) * 100).toFixed(1) : "0.0";
      return { nome: u.name, antes, depois, pct: Number(pct) };
    })
    .sort((a, b) => a.depois - b.depois);

  for (const l of linhas) {
    const marca = l.depois < LIMIAR_OSSO ? " ⚠ osso" : "";
    console.log(`${l.nome.padEnd(28)}${String(l.antes).padStart(8)}${String(l.depois).padStart(8)}${String(l.pct).padStart(6)}%${marca}`);
  }

  const emOsso = linhas.filter((l) => l.depois < LIMIAR_OSSO);
  console.log(`\n=== VEREDITO ===`);
  console.log(`Limiar de "osso": < ${LIMIAR_OSSO} produtos depois do filtro.`);
  if (!emOsso.length) {
    console.log(`Nenhum dos 34 universos fica abaixo do limiar. Sem tensão — os 34 abrem normalmente.`);
  } else {
    console.log(`${emOsso.length} universo(s) em osso: ${emOsso.map((l) => `${l.nome} (${l.depois})`).join(", ")}`);
  }

  console.log(`\nSem franquia (órfãos), antes do filtro: ${semFranquia}`);
  console.log(`Sem franquia (órfãos), depois do filtro: ${filtradoSemFranquia}`);
  console.log(`\nLido: ${lidos} de ${total}\n`);
}

main()
  .catch((err) => {
    console.error(`\n${err?.stack || err?.message || err}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
