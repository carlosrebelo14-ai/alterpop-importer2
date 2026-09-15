#!/usr/bin/env node
/**
 * Briefing backend 15/09/2026 · B3 + B4 — censo de fabricantes e medição dos 15
 * personagens, na mesma corrida (spec explícita: "Read-only, mesma corrida do B3").
 *
 * B3 — o que este script NÃO consegue dar: "quais dos 28 nomes da taxonomia aparecem
 * no feed" e "não classificados" pressupõem a lista de 28 nomes de
 * `alterpop.manufacturer_tier` (B5). Não a encontrei no repositório nem na memória do
 * projeto — o briefing dizia que estava lá, mas não está em sítio nenhum que eu tenha
 * acesso. Reportado no fim, não inventado. O resto de B3 (fabricantes distintos por
 * contagem, amostra de títulos por fabricante para a decisão de manufacturer_line)
 * corre normalmente.
 *
 * B4 — os 15 nomes e os universos-base vêm literalmente do briefing. As armadilhas
 * conhecidas (Grogu="Baby Yoda"/"The Child", Din Djarin="The Mandalorian"/"Mando",
 * Frieza="Freezer") entram como aliases no MESMO nome — a medição é para revelar a
 * amplitude do problema, não para escondê-la escolhendo só a grafia limpa.
 *
 * SÓ LEITURA. Não escreve nada. Paginação por cursor (padrão Tarefa 17). Qualquer falha
 * de leitura aborta com exit != 0 (Decisão 30).
 *
 * Correr:  node scripts/catalog/manufacturer-character-census.js
 *          node scripts/catalog/manufacturer-character-census.js --amostras-fabricante 8
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";

const args = process.argv.slice(2);
const valOf = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const SHOP = valOf("--shop", process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com");
const PAGE = 500;
const N_FABRICANTES_TOPO = parseInt(valOf("--top-fabricantes", "30"), 10) || 30;
const N_AMOSTRAS_FABRICANTE = parseInt(valOf("--amostras-fabricante", "6"), 10) || 6;
const N_AMOSTRAS_PERSONAGEM = 10;

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// B4 — os 15 nomes do briefing, com universo-base e as armadilhas conhecidas como
// aliases do mesmo nome (não entradas à parte — a medição soma-as, para o total
// revelar quanto do "Total" é ambiguidade, não escondê-la atrás de uma grafia só).
const PERSONAGENS = [
  { nome: "Darth Vader", universo: "Star Wars", aliases: ["Darth Vader"] },
  { nome: "Luke Skywalker", universo: "Star Wars", aliases: ["Luke Skywalker"] },
  { nome: "Ahsoka Tano", universo: "Star Wars", aliases: ["Ahsoka Tano", "Ahsoka"] },
  { nome: "Grogu", universo: "Star Wars", aliases: ["Grogu", "Baby Yoda", "The Child"] },
  { nome: "Din Djarin", universo: "Star Wars", aliases: ["Din Djarin", "The Mandalorian", "Mando"] },
  { nome: "Goku", universo: "Dragon Ball", aliases: ["Goku"] },
  { nome: "Vegeta", universo: "Dragon Ball", aliases: ["Vegeta"] },
  { nome: "Gohan", universo: "Dragon Ball", aliases: ["Gohan"] },
  { nome: "Frieza", universo: "Dragon Ball", aliases: ["Frieza", "Freezer"] },
  { nome: "Piccolo", universo: "Dragon Ball", aliases: ["Piccolo"] },
  { nome: "Batman", universo: "Batman", aliases: ["Batman"] },
  { nome: "Joker", universo: "Batman", aliases: ["Joker"] },
  { nome: "Harley Quinn", universo: "Batman", aliases: ["Harley Quinn"] },
  { nome: "Catwoman", universo: "Batman", aliases: ["Catwoman"] },
  { nome: "Robin", universo: "Batman", aliases: ["Robin"] },
];

for (const p of PERSONAGENS) {
  p.regexes = p.aliases.map((a) => new RegExp(`\\b${escapeRegExp(a)}\\b`, "i"));
  p.total = 0;
  p.dentro = 0;
  p.fora = 0;
  p.foraDetalhe = new Map(); // resolvedFranchise -> contagem
  p.orfaos = 0;
  p.amostras = [];
}

async function main() {
  const totalCatalog = await prisma.catalogProduct.count({ where: { shop: SHOP } });
  console.log(`\n=== manufacturer-character-census (${SHOP}) — briefing backend B3 + B4 ===\n`);
  console.log(`CatalogProduct: ${totalCatalog}\n`);

  const porFabricante = new Map(); // vendor -> { count, amostras: [] }

  let lidos = 0;
  let cursor = null;
  for (;;) {
    let rows;
    try {
      rows = await prisma.catalogProduct.findMany({
        where: { shop: SHOP },
        select: { sku: true, title: true, vendor: true, resolvedFranchise: true },
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
      const title = r.title || "";

      // B3 — fabricantes
      const vendor = (r.vendor || "").trim() || "(sem fabricante)";
      if (!porFabricante.has(vendor)) porFabricante.set(vendor, { count: 0, amostras: [] });
      const fEntry = porFabricante.get(vendor);
      fEntry.count += 1;
      if (fEntry.amostras.length < N_AMOSTRAS_FABRICANTE) fEntry.amostras.push(title);

      // B4 — personagens
      for (const p of PERSONAGENS) {
        if (!p.regexes.some((re) => re.test(title))) continue;
        p.total += 1;
        if (p.amostras.length < N_AMOSTRAS_PERSONAGEM) p.amostras.push({ sku: r.sku, title, franquia: r.resolvedFranchise });
        if (r.resolvedFranchise == null) {
          p.orfaos += 1;
        } else if (r.resolvedFranchise === p.universo) {
          p.dentro += 1;
        } else {
          p.fora += 1;
          p.foraDetalhe.set(r.resolvedFranchise, (p.foraDetalhe.get(r.resolvedFranchise) || 0) + 1);
        }
      }
    }

    cursor = { shop: SHOP, sku: rows[rows.length - 1].sku };
    if (rows.length < PAGE) break;
  }

  // ---------------------------------------------------------------------------------
  console.log(`## B3 — CENSO DE FABRICANTES\n`);
  console.log(`Fabricantes distintos: ${porFabricante.size}\n`);
  const ordenados = [...porFabricante.entries()].sort((a, b) => b[1].count - a[1].count);
  console.log(`Top ${N_FABRICANTES_TOPO} por contagem:\n`);
  for (const [vendor, entry] of ordenados.slice(0, N_FABRICANTES_TOPO)) {
    console.log(`  ${String(entry.count).padStart(6)}  ${vendor}`);
  }
  console.log(`\nAmostras de título por fabricante (para decidir alterpop.manufacturer_line) —`);
  console.log(`só os ${N_FABRICANTES_TOPO} do topo:\n`);
  for (const [vendor, entry] of ordenados.slice(0, N_FABRICANTES_TOPO)) {
    console.log(`  ${vendor} (${entry.count}):`);
    for (const t of entry.amostras) console.log(`      "${t}"`);
  }

  console.log(`\n"Quais dos 28 nomes da taxonomia aparecem no feed" e "não classificados, por`);
  console.log(`contagem" — NÃO MEDIDO. A lista de 28 nomes de alterpop.manufacturer_tier não`);
  console.log(`foi encontrada no repositório nem na memória do projeto. Preciso da lista para`);
  console.log(`fechar esta parte de B3.`);

  // ---------------------------------------------------------------------------------
  console.log(`\n\n## B4 — MEDIÇÃO DOS 15 PERSONAGENS\n`);
  console.log(
    `${"Nome".padEnd(16)}${"Universo".padEnd(12)}${"Total".padStart(7)}${"Dentro".padStart(9)}${"Fora".padStart(7)}${"Órfãos".padStart(9)}`
  );
  for (const p of PERSONAGENS) {
    console.log(
      `${p.nome.padEnd(16)}${p.universo.padEnd(12)}${String(p.total).padStart(7)}${String(p.dentro).padStart(9)}${String(p.fora).padStart(7)}${String(p.orfaos).padStart(9)}`
    );
  }

  for (const p of PERSONAGENS) {
    console.log(`\n--- ${p.nome} (aliases: ${p.aliases.join(" / ")}) ---`);
    if (p.fora > 0) {
      console.log(`  FORA DO UNIVERSO (colisão) — ${p.fora}:`);
      for (const [franquia, n] of [...p.foraDetalhe.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`      ${n}  ${franquia}`);
      }
    }
    console.log(`  amostra (até ${N_AMOSTRAS_PERSONAGEM}):`);
    for (const a of p.amostras) {
      console.log(`      ${a.sku}  [franquia=${a.franquia ?? "—"}]  "${a.title}"`);
    }
  }

  console.log(`\nLido: ${lidos} de ${totalCatalog}\n`);
}

main()
  .catch((err) => {
    console.error(`\n${err?.stack || err?.message || err}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
