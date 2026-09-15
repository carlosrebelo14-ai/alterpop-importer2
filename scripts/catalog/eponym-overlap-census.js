#!/usr/bin/env node
/**
 * Briefing backend 15/09/2026 · última régua do vocabulário de personagens — os
 * epónimos (o personagem dá nome à própria franquia). Regra do Carlos: se "Dentro do
 * universo" para o nome for >= EPONYM_LIMIAR_PCT (80%) do total do universo, a página
 * do personagem duplicaria a sala do universo inteiro — sai do vocabulário. Não é
 * automático; mede-se caso a caso (o Batman pode ficar abaixo, por ter Joker/Harley
 * Quinn/Catwoman a partilhar a sala).
 *
 * Diferente da medição B4 normal: aqui o denominador não é "quantos produtos pegam no
 * nome", é "quantos produtos tem o universo, ao todo" — por isso corre à parte, com uma
 * segunda contagem (universoTotal) que B4 nunca precisou.
 *
 * SÓ LEITURA. Não escreve nada. Paginação por cursor (padrão Tarefa 17). Qualquer falha
 * de leitura aborta com exit != 0 (Decisão 30).
 *
 * Correr:  node scripts/catalog/eponym-overlap-census.js
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { EPONYM_CANDIDATES, EPONYM_LIMIAR_PCT } from "../../lib/importer/catalog/characterVocabulary.js";

const args = process.argv.slice(2);
const valOf = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const SHOP = valOf("--shop", process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com");
const PAGE = 500;

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ITENS = EPONYM_CANDIDATES.map((c) => ({
  ...c,
  regexes: [c.nome, ...(c.aliases || [])].map((a) => new RegExp(`\\b${escapeRegExp(a)}\\b`, "i")),
  universoTotal: 0,
  dentro: 0,
}));

const pct = (parte, total) => (total ? ((parte / total) * 100).toFixed(1) : "0.0");

async function main() {
  const universosAlvo = new Set(ITENS.map((i) => i.universo));

  console.log(`\n=== eponym-overlap-census (${SHOP}) — briefing backend, régua dos epónimos ===\n`);
  console.log(`Nomes: ${ITENS.map((i) => i.nome).join(", ")}\n`);

  let lidos = 0;
  let cursor = null;
  for (;;) {
    let rows;
    try {
      rows = await prisma.catalogProduct.findMany({
        where: { shop: SHOP, resolvedFranchise: { in: [...universosAlvo] } },
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
      for (const item of ITENS) {
        if (r.resolvedFranchise !== item.universo) continue;
        item.universoTotal += 1;
        if (item.regexes.some((re) => re.test(r.title || ""))) item.dentro += 1;
      }
    }

    cursor = { shop: SHOP, sku: rows[rows.length - 1].sku };
    if (rows.length < PAGE) break;
  }

  console.log(`Lido (só universos-alvo): ${lidos}\n`);
  console.log(
    `${"Nome".padEnd(14)}${"Universo".padEnd(24)}${"Dentro".padStart(8)}${"Universo total".padStart(16)}${"%".padStart(8)}  Veredicto`
  );
  for (const item of ITENS) {
    const percentagem = pct(item.dentro, item.universoTotal);
    const dispara = item.universoTotal > 0 && Number(percentagem) >= EPONYM_LIMIAR_PCT;
    const veredicto = dispara
      ? `SAI (duplica a sala, >= ${EPONYM_LIMIAR_PCT}%)`
      : "fica";
    console.log(
      `${item.nome.padEnd(14)}${item.universo.padEnd(24)}${String(item.dentro).padStart(8)}${String(item.universoTotal).padStart(16)}${percentagem.padStart(7)}%  ${veredicto}`
    );
  }
  console.log();
}

main()
  .catch((err) => {
    console.error(`\n${err?.stack || err?.message || err}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
