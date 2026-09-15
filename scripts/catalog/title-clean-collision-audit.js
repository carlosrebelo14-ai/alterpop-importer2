#!/usr/bin/env node
/**
 * Briefing backend 15/09/2026 · B0 — as duas contagens que faltam antes do merge/deploy
 * do averbamento à Decisão 17 (PR #68).
 *
 *   A) títulos limpos (cleanTitle) IGUAIS ao nome da franquia ou da line resolvida
 *      — normalizados (normalizeForMatch), porque o strip pode deixar só o nome próprio.
 *   B) títulos limpos DUPLICADOS entre si, ATRIBUÍVEIS a este averbamento
 *      — o catálogo já tem milhares de duplicados estruturais alheios a isto (merch em
 *      vários tamanhos sem tamanho no título: "One Piece ... adult t-shirt" x30). Contar
 *      esses contra um limiar de 20 não faz sentido de gate para ESTE PR. B mede, em vez
 *      disso, quantas linhas onde o prefixo saiu (prefixoPassagens > 0) passaram a
 *      colidir com o cleanTitle de OUTRA linha qualquer — colisão nova, causada pelo
 *      strip, não duplicado pré-existente.
 *
 * Regra do briefing: A + B <= 20 -> merge e deploy sem voltar atrás.
 *                     A + B >  20 -> parar; o travão do mínimo passa a comparar a string
 *                     inteira contra aliases multi-palavra, não só a última palavra sobrada.
 *
 * SÓ RELATÓRIO. Não escreve nada. Paginação por cursor (padrão Tarefa 17, máquina 512 MB
 * na Fly). Qualquer falha de leitura aborta com exit != 0 (Decisão 30).
 *
 * Correr:  node scripts/catalog/title-clean-collision-audit.js
 *          node scripts/catalog/title-clean-collision-audit.js --exemplos 20
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { cleanProductTitleWithTrace } from "../../lib/importer/catalog/titleCleaner.server.js";
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
  console.log(`\n=== title-clean-collision-audit (${SHOP}) — briefing backend B0 ===\n`);
  console.log(`CatalogProduct: ${total}\n`);

  let lidos = 0;
  const igualFranquiaOuLine = [];
  const porCleanTitleNorm = new Map(); // normalizeForMatch(cleanTitle) -> [{sku, cleanTitle, title, prefixoPassagens}]

  let cursor = null;
  for (;;) {
    let rows;
    try {
      rows = await prisma.catalogProduct.findMany({
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
    if (!rows.length) break;

    for (const r of rows) {
      lidos += 1;
      const { result: cleanTitle, prefixoPassagens } = cleanProductTitleWithTrace(r);
      const normClean = normalizeForMatch(cleanTitle);

      // A — igual ao nome da franquia ou da line resolvida
      const normFranquia = r.resolvedFranchise ? normalizeForMatch(r.resolvedFranchise) : null;
      const normLine = r.resolvedLine ? normalizeForMatch(r.resolvedLine) : null;
      if ((normFranquia && normClean === normFranquia) || (normLine && normClean === normLine)) {
        igualFranquiaOuLine.push({
          sku: r.sku,
          title: r.title,
          cleanTitle,
          franquia: r.resolvedFranchise,
          line: r.resolvedLine,
        });
      }

      if (!normClean) continue;
      if (!porCleanTitleNorm.has(normClean)) porCleanTitleNorm.set(normClean, []);
      porCleanTitleNorm.get(normClean).push({ sku: r.sku, cleanTitle, title: r.title, prefixoPassagens });
    }

    cursor = { shop: SHOP, sku: rows[rows.length - 1].sku };
    if (rows.length < PAGE) break;
  }

  // B — só grupos com >1 membro E onde pelo menos um membro só lá está porque o prefixo
  // saiu (prefixoPassagens > 0). Duplicados 100% pré-existentes (nenhum membro mexido
  // por este averbamento) não contam para o gate deste PR.
  const gruposTodos = [...porCleanTitleNorm.values()].filter((g) => g.length > 1);
  const gruposCausados = gruposTodos.filter((g) => g.some((m) => m.prefixoPassagens > 0));
  const linhasCausadasPeloPrefixo = gruposCausados.reduce(
    (acc, g) => acc + g.filter((m) => m.prefixoPassagens > 0).length,
    0
  );

  const A = igualFranquiaOuLine.length;
  const B = linhasCausadasPeloPrefixo;

  console.log(`A. TÍTULO LIMPO = NOME DA FRANQUIA OU LINE RESOLVIDA`);
  console.log(`   ${A} de ${lidos}  (${pct(A, lidos)}%)`);
  for (const e of igualFranquiaOuLine.slice(0, N_EXEMPLOS)) {
    console.log(`     ${e.sku}: "${e.title}" -> "${e.cleanTitle}"   [franquia=${e.franquia ?? "—"} line=${e.line ?? "—"}]`);
  }

  console.log(`\nB. TÍTULOS LIMPOS DUPLICADOS ENTRE SI, CAUSADOS POR ESTE AVERBAMENTO`);
  console.log(`   (duplicados pré-existentes no catálogo, alheios a este PR: ${gruposTodos.length} grupo(s), ${gruposTodos.reduce((a, g) => a + g.length, 0)} linha(s) — fora do gate)`);
  console.log(`   ${gruposCausados.length} grupo(s) com pelo menos um membro mexido pelo prefixo`);
  console.log(`   ${B} linha(s) que só colidem porque o prefixo saiu  (${pct(B, lidos)}%)`);
  const gruposOrdenados = [...gruposCausados].sort((a, b) => b.length - a.length);
  for (const g of gruposOrdenados.slice(0, N_EXEMPLOS)) {
    console.log(`     "${g[0].cleanTitle}"  x${g.length}  (${g.filter((m) => m.prefixoPassagens > 0).length} por este PR)`);
    for (const item of g.slice(0, 5)) {
      console.log(`         ${item.sku}${item.prefixoPassagens > 0 ? " [prefixo saiu]" : ""}: "${item.title}"`);
    }
    if (g.length > 5) console.log(`         ... e mais ${g.length - 5}`);
  }

  console.log(`\n=== VEREDITO (briefing B0) ===`);
  console.log(`   A + B = ${A} + ${B} = ${A + B}`);
  if (A + B <= 20) {
    console.log(`   <= 20  ->  merge e deploy sem voltar atrás.`);
  } else {
    console.log(`   > 20  ->  PARAR. Travão do mínimo passa a comparar a string inteira`);
    console.log(`             contra aliases multi-palavra, não só a última palavra sobrada.`);
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
