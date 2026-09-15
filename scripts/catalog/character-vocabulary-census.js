#!/usr/bin/env node
/**
 * Briefing backend 15/09/2026 · anexo — mede o vocabulário de personagens dos 31
 * universos entregue pelo Carlos (lib/importer/catalog/characterVocabulary.js), na
 * mesma forma que B4 mediu os 15 nomes originais (Star Wars/Dragon Ball/Batman, esses
 * já fechados em scripts/catalog/manufacturer-character-census.js — este script não os
 * repete).
 *
 * Por nome: Total, Dentro do universo, Fora do universo (colisão), Órfãos (sem
 * franquia), amostra de até 10 títulos — exatamente as quatro contagens do B4.
 *
 * Nomes de risco alto (HIGH_RISK_NAMES) saem marcados à parte, com veredicto aplicando
 * a regra do Carlos: se Fora > Dentro, o padrão é o mesmo do Robin — sai do
 * vocabulário, não entra na passagem B de B7. "Thing" mede-se contra Wednesday (a
 * origem de onde foi removido) mesmo não estando na lista principal desse universo.
 *
 * SÓ LEITURA. Não escreve nada. Paginação por cursor (padrão Tarefa 17). Qualquer falha
 * de leitura aborta com exit != 0 (Decisão 30).
 *
 * Correr:  node scripts/catalog/character-vocabulary-census.js
 *          node scripts/catalog/character-vocabulary-census.js --amostras 5
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import {
  CHARACTER_VOCABULARY,
  CHARACTER_ALIASES,
  HIGH_RISK_NAMES,
  THING_UNIVERSO_ORIGEM,
} from "../../lib/importer/catalog/characterVocabulary.js";

const args = process.argv.slice(2);
const valOf = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const SHOP = valOf("--shop", process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com");
const PAGE = 500;
const N_AMOSTRAS = parseInt(valOf("--amostras", "10"), 10) || 10;

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Lista achatada: um item por nome, com o universo-base e os aliases medidos juntos.
const ITENS = [];
for (const entry of CHARACTER_VOCABULARY) {
  for (const nome of entry.nomes) {
    const aliases = [nome, ...(CHARACTER_ALIASES[nome] || [])];
    ITENS.push({ nome, universo: entry.universo, aliases, risco: HIGH_RISK_NAMES.includes(nome) });
  }
}
// "Thing" — não está em nenhuma entrada de CHARACTER_VOCABULARY (removido de Wednesday).
ITENS.push({ nome: "Thing", universo: THING_UNIVERSO_ORIGEM, aliases: ["Thing"], risco: true, semVocabulario: true });

for (const item of ITENS) {
  item.regexes = item.aliases.map((a) => new RegExp(`\\b${escapeRegExp(a)}\\b`, "i"));
  item.total = 0;
  item.dentro = 0;
  item.fora = 0;
  item.foraDetalhe = new Map();
  item.orfaos = 0;
  item.amostras = [];
}

async function main() {
  const totalCatalog = await prisma.catalogProduct.count({ where: { shop: SHOP } });
  console.log(`\n=== character-vocabulary-census (${SHOP}) — anexo ao briefing, 31 universos ===\n`);
  console.log(`CatalogProduct: ${totalCatalog}`);
  console.log(`Nomes medidos: ${ITENS.length} (${ITENS.length - 1} do vocabulário + "Thing")\n`);

  let lidos = 0;
  let cursor = null;
  for (;;) {
    let rows;
    try {
      rows = await prisma.catalogProduct.findMany({
        where: { shop: SHOP },
        select: { sku: true, title: true, resolvedFranchise: true },
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
      for (const item of ITENS) {
        if (!item.regexes.some((re) => re.test(title))) continue;
        item.total += 1;
        if (item.amostras.length < N_AMOSTRAS) {
          item.amostras.push({ sku: r.sku, title, franquia: r.resolvedFranchise });
        }
        if (r.resolvedFranchise == null) {
          item.orfaos += 1;
        } else if (r.resolvedFranchise === item.universo) {
          item.dentro += 1;
        } else {
          item.fora += 1;
          item.foraDetalhe.set(r.resolvedFranchise, (item.foraDetalhe.get(r.resolvedFranchise) || 0) + 1);
        }
      }
    }

    cursor = { shop: SHOP, sku: rows[rows.length - 1].sku };
    if (rows.length < PAGE) break;
  }

  console.log(`Lido: ${lidos} de ${totalCatalog}\n`);

  // Agrupado por universo, na ordem do ficheiro.
  for (const entry of CHARACTER_VOCABULARY) {
    console.log(`\n## ${entry.universo}\n`);
    console.log(
      `${"Nome".padEnd(20)}${"Total".padStart(7)}${"Dentro".padStart(9)}${"Fora".padStart(7)}${"Órfãos".padStart(9)}  `
    );
    for (const nome of entry.nomes) {
      const item = ITENS.find((i) => i.nome === nome && i.universo === entry.universo);
      const marca = item.risco ? " ⚠ risco" : "";
      console.log(
        `${item.nome.padEnd(20)}${String(item.total).padStart(7)}${String(item.dentro).padStart(9)}${String(item.fora).padStart(7)}${String(item.orfaos).padStart(9)}${marca}`
      );
    }
  }

  console.log(`\n\n## NOMES DE RISCO ALTO — veredicto (regra do Robin: Fora > Dentro => sai)\n`);
  console.log(
    `${"Nome".padEnd(14)}${"Universo".padEnd(24)}${"Total".padStart(7)}${"Dentro".padStart(9)}${"Fora".padStart(7)}${"Órfãos".padStart(9)}  Veredicto`
  );
  const itensRisco = ITENS.filter((i) => i.risco);
  for (const item of itensRisco) {
    const veredicto = item.fora > item.dentro ? "SAI (fora > dentro)" : "fica";
    console.log(
      `${item.nome.padEnd(14)}${item.universo.padEnd(24)}${String(item.total).padStart(7)}${String(item.dentro).padStart(9)}${String(item.fora).padStart(7)}${String(item.orfaos).padStart(9)}  ${veredicto}`
    );
  }

  console.log(`\nDetalhe de "fora" e amostras, só para os que dispararam o veredicto SAI:\n`);
  for (const item of itensRisco.filter((i) => i.fora > i.dentro)) {
    console.log(`--- ${item.nome} (universo-base: ${item.universo}) ---`);
    console.log(`  FORA DO UNIVERSO — ${item.fora}:`);
    for (const [franquia, n] of [...item.foraDetalhe.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`      ${n}  ${franquia}`);
    }
    console.log(`  amostra (até ${N_AMOSTRAS}):`);
    for (const a of item.amostras) {
      console.log(`      ${a.sku}  [franquia=${a.franquia ?? "—"}]  "${a.title}"`);
    }
    console.log();
  }
}

main()
  .catch((err) => {
    console.error(`\n${err?.stack || err?.message || err}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
