#!/usr/bin/env node
/**
 * Briefing backend 15/09/2026 · B0, portão corrigido — mede o RESIDUAL CAUSADO POR ESTE
 * PR (não A+B do briefing original, que contava dívida pré-existente do catálogo contra
 * um limiar que nunca lhe dizia respeito).
 *
 * Histórico da medição:
 *   1.ª corrida (sem correção nenhuma):                A=19,  B=861  (A+B=880)
 *   2.ª corrida (resolveTitleCollisions + travão na string do laço do prefixo): A=2, B=25
 *   3.ª corrida (este script — travão avalia o cleanTitle FINAL, não o candidato a meio
 *   do laço; resolveTitleCollisions confirmado a agrupar pelo mesmo final):    A=0
 *
 * Por que B deixou de fazer parte do portão: `resolveTitleCollisions` já reverte o strip
 * do prefixo em QUALQUER grupo colidente. Qualquer colisão que sobreviva a essa reversão
 * é, por construção, uma colisão que já existia (ou continuaria a existir) mesmo com o
 * prefixo intacto — não é o prefixo que a causa, e reverter o prefixo não a resolve. É
 * dívida do catálogo (grafias diferentes que o alias-repetido normaliza para o mesmo
 * texto: "Spiderman" vs "Spider-Man", Decisão 8) que este PR não causa nem pode
 * resolver. Reportada para o registo, fora do portão.
 *
 *   RESIDUAL CAUSADO POR ESTE PR = A (cleanTitle final == franquia/line, depois do
 *   travão 3). Regra: zero -> merge e deploy. Acima de zero -> parar e trazer o caso.
 *
 * SÓ RELATÓRIO. Não escreve nada. `resolveTitleCollisions` precisa de ver todos os
 * candidatos de uma vez para agrupar — lê o catálogo inteiro para memória, mas só os
 * campos leves (sku/title/resolvedFranchise/resolvedLine/resolvedFormat), não linhas
 * Prisma completas (poucos MB para ~25 mil produtos, nada a ver com o OOM da Tarefa 17,
 * que era sobre linhas pesadas). A leitura em si continua paginada por cursor. Qualquer
 * falha de leitura aborta com exit != 0 (Decisão 30).
 *
 * Correr:  node scripts/catalog/title-clean-collision-audit.js
 *          node scripts/catalog/title-clean-collision-audit.js --exemplos 20
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { resolveTitleCollisions } from "../../lib/importer/catalog/titleCleaner.server.js";
import { normalizeForMatch } from "../../lib/importer/shopify/universeCollections.server.js";

const args = process.argv.slice(2);
const valOf = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const SHOP = valOf("--shop", process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com");
const N_EXEMPLOS = parseInt(valOf("--exemplos", "20"), 10) || 20;
const PAGE = 500;

const pct = (parte, total) => (total ? ((parte / total) * 100).toFixed(2) : "0.00");

async function main() {
  const total = await prisma.catalogProduct.count({ where: { shop: SHOP } });
  console.log(`\n=== title-clean-collision-audit (${SHOP}) — briefing backend B0, portão corrigido ===\n`);
  console.log(`CatalogProduct: ${total}\n`);

  const rows = [];
  let cursor = null;
  for (;;) {
    let page;
    try {
      page = await prisma.catalogProduct.findMany({
        where: { shop: SHOP },
        select: {
          shop: true,
          sku: true,
          title: true,
          resolvedFranchise: true,
          resolvedLine: true,
          resolvedFormat: true,
        },
        orderBy: [{ shop: "asc" }, { sku: "asc" }],
        take: PAGE,
        ...(cursor ? { cursor: { shop_sku: cursor }, skip: 1 } : {}),
      });
    } catch (err) {
      throw new Error(`FALHA DE LEITURA (CatalogProduct): ${err?.message || err}`);
    }
    if (!page.length) break;
    for (const r of page) {
      rows.push({
        key: r.sku,
        title: r.title,
        resolvedFranchise: r.resolvedFranchise,
        resolvedLine: r.resolvedLine,
        resolvedFormat: r.resolvedFormat,
      });
    }
    cursor = { shop: SHOP, sku: page[page.length - 1].sku };
    if (page.length < PAGE) break;
  }

  const lidos = rows.length;
  const porSku = new Map(rows.map((r) => [r.key, r]));
  const resultados = resolveTitleCollisions(rows);

  // A — RESIDUAL CAUSADO POR ESTE PR. Com o travão 3 (avalia o cleanTitle final, não o
  // candidato a meio do laço) já dentro de cleanProductTitleWithTrace, isto devia dar
  // zero: qualquer colapso para o nome da franquia/line, venha do laço do prefixo ou de
  // uma regra posterior, já é apanhado e revertido antes de chegar aqui.
  const igualFranquiaOuLine = [];
  for (const res of resultados) {
    const original = porSku.get(res.key);
    const normClean = normalizeForMatch(res.result);
    const normFranquia = original.resolvedFranchise ? normalizeForMatch(original.resolvedFranchise) : null;
    const normLine = original.resolvedLine ? normalizeForMatch(original.resolvedLine) : null;
    if ((normFranquia && normClean === normFranquia) || (normLine && normClean === normLine)) {
      igualFranquiaOuLine.push({
        sku: res.key,
        title: original.title,
        cleanTitle: res.result,
        franquia: original.resolvedFranchise,
        line: original.resolvedLine,
      });
    }
  }

  // Dívida pré-existente — grupos que colidem MESMO depois de resolveTitleCollisions já
  // ter revertido o que dava para reverter. Por construção, alheios a este PR (ver
  // cabeçalho). Só para registo, fora do portão.
  const porCleanTitleNorm = new Map();
  for (const res of resultados) {
    const norm = normalizeForMatch(res.result);
    if (!norm) continue;
    if (!porCleanTitleNorm.has(norm)) porCleanTitleNorm.set(norm, []);
    porCleanTitleNorm.get(norm).push(res);
  }
  const gruposDivida = [...porCleanTitleNorm.values()].filter((g) => g.length > 1);
  const linhasDivida = gruposDivida.reduce((acc, g) => acc + g.length, 0);

  const totalRevertidos = resultados.filter((r) => r.colisaoRevertida).length;
  const totalMudam = resultados.filter((r) => {
    const original = porSku.get(r.key);
    return r.result !== original.title;
  }).length;

  const RESIDUAL = igualFranquiaOuLine.length;

  console.log(`RESULTADO ESPERADO PELO BRIEFING: ~5 012 títulos mudam, 880 mantêm o prefixo`);
  console.log(`RESULTADO MEDIDO:`);
  console.log(`   títulos que mudam:                      ${totalMudam} de ${lidos}  (${pct(totalMudam, lidos)}%)`);
  console.log(`   mantêm o prefixo por colisão revertida:  ${totalRevertidos}\n`);

  console.log(`RESIDUAL CAUSADO POR ESTE PR (cleanTitle final == franquia/line, pós travão 3)`);
  console.log(`   ${RESIDUAL} de ${lidos}  (${pct(RESIDUAL, lidos)}%)`);
  for (const e of igualFranquiaOuLine.slice(0, N_EXEMPLOS)) {
    console.log(`     ${e.sku}: "${e.title}" -> "${e.cleanTitle}"   [franquia=${e.franquia ?? "—"} line=${e.line ?? "—"}]`);
  }

  console.log(`\nDÍVIDA PRÉ-EXISTENTE (fora do portão — grafias diferentes que o alias-repetido/`);
  console.log(`dash-repetido, Decisão 8, já normalizava para o mesmo texto antes desta averbamento)`);
  console.log(`   ${gruposDivida.length} grupo(s), ${linhasDivida} linha(s)  (${pct(linhasDivida, lidos)}%)`);
  const gruposOrdenados = [...gruposDivida].sort((a, b) => b.length - a.length);
  for (const g of gruposOrdenados.slice(0, N_EXEMPLOS)) {
    console.log(`     "${g[0].result}"  x${g.length}`);
    for (const item of g.slice(0, 5)) {
      const original = porSku.get(item.key);
      console.log(`         ${item.key}: "${original.title}"`);
    }
    if (g.length > 5) console.log(`         ... e mais ${g.length - 5}`);
  }

  console.log(`\n=== VEREDITO (briefing B0, portão corrigido) ===`);
  console.log(`   residual causado por este PR = ${RESIDUAL}`);
  if (RESIDUAL === 0) {
    console.log(`   0  ->  merge e deploy sem voltar atrás.`);
  } else {
    console.log(`   > 0  ->  PARAR. Trazer o(s) caso(s) acima.`);
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
