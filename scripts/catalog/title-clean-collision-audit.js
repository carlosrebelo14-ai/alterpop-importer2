#!/usr/bin/env node
/**
 * Briefing backend 15/09/2026 · B0 — mede A e B depois da correção "strip com
 * consciência de colisão" (lib/importer/catalog/titleCleaner.server.js →
 * resolveTitleCollisions). Primeira corrida (sem a correção) deu A=19, B=861,
 * A+B=880 > 20 — o portão travou. Esta é a remedição sobre o residual.
 *
 *   A) títulos limpos (cleanTitle) IGUAIS ao nome da franquia ou da line resolvida
 *      — agora bloqueado pelo travão do mínimo (compara a string inteira, não só a
 *      última palavra). Esperado: 0.
 *   B) títulos limpos DUPLICADOS entre si, ATRIBUÍVEIS a este averbamento
 *      — agora resolveTitleCollisions reverte o strip nos dois lados de qualquer
 *      colisão que ele próprio causasse. Esperado: perto de zero (só sobra se a
 *      colisão existir mesmo com o prefixo intacto, o que já seria duplicado
 *      estrutural, fora do gate deste PR).
 *
 * Regra do briefing: A + B <= 20 -> merge e deploy sem voltar atrás.
 *                     A + B >  20 -> parar outra vez.
 *
 * SÓ RELATÓRIO. Não escreve nada. `resolveTitleCollisions` precisa de ver TODOS os
 * candidatos de uma vez para agrupar — por isso este script lê o catálogo inteiro para
 * memória, mas só os campos leves (sku/title/resolvedFranchise/resolvedLine/
 * resolvedFormat), não as linhas Prisma completas: é a mesma distinção que evitou o OOM
 * da Tarefa 17, aplicada ao contrário — poucos MB para ~25 mil produtos, não centenas.
 * A leitura em si continua paginada por cursor. Qualquer falha de leitura aborta com
 * exit != 0 (Decisão 30).
 *
 * Correr:  node scripts/catalog/title-clean-collision-audit.js
 *          node scripts/catalog/title-clean-collision-audit.js --exemplos 20
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { resolveTitleCollisions, cleanProductTitleWithTrace } from "../../lib/importer/catalog/titleCleaner.server.js";
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
  console.log(`\n=== title-clean-collision-audit (${SHOP}) — briefing backend B0, pós-correção ===\n`);
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

  // resolveTitleCollisions reverte QUALQUER grupo colidente, incluindo duplicados
  // 100% pré-existentes (nenhum prefixo, nada a reverter — no-op mecânico, mas
  // colisaoRevertida sai `true` na mesma). Para separar "causado por este PR" preciso
  // do prefixoPassagens da PASSAGEM 1 — antes de qualquer reversão — não do 0 que o
  // resultado final devolve para linhas revertidas.
  const pass1PorSku = new Map(rows.map((r) => [r.key, cleanProductTitleWithTrace(r).prefixoPassagens]));

  // A — cleanTitle final == nome da franquia ou line resolvida
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

  // B — depois da correção, ainda pode sobrar colisão residual: dois produtos que
  // colidem MESMO com o prefixo intacto (nenhum tinha prefixo para reverter, ou têm o
  // mesmo prefixo também). resolveTitleCollisions já reverteu o que dava para reverter;
  // o que aqui aparece é o que ficou por resolver.
  const porCleanTitleNorm = new Map();
  for (const res of resultados) {
    const norm = normalizeForMatch(res.result);
    if (!norm) continue;
    if (!porCleanTitleNorm.has(norm)) porCleanTitleNorm.set(norm, []);
    porCleanTitleNorm.get(norm).push(res);
  }
  // Mesmo com prefixoPassagens>0 na passagem 1, um grupo residual só é CAUSADO por
  // este averbamento se os títulos BRUTOS (antes de qualquer limpeza) diferem entre si.
  // Se já vinham do fornecedor byte a byte iguais ("POP figure Pokemon Pikachu" x4, sem
  // nada a distinguir mesmo com o prefixo intacto), reverter o strip não resolve nada —
  // é duplicação pré-existente no feed, categoria dos t-shirts por tamanho, fora deste
  // gate.
  const gruposResidual = [...porCleanTitleNorm.values()].filter((g) => {
    if (g.length <= 1) return false;
    if (!g.some((m) => pass1PorSku.get(m.key) > 0)) return false;
    const titulosBrutos = new Set(g.map((m) => normalizeForMatch(porSku.get(m.key).title)));
    return titulosBrutos.size > 1;
  });
  const linhasResidual = gruposResidual.reduce((acc, g) => acc + g.length, 0);

  const totalRevertidos = resultados.filter((r) => r.colisaoRevertida).length;
  const totalMudam = resultados.filter((r) => {
    const original = porSku.get(r.key);
    return r.result !== original.title;
  }).length;

  const A = igualFranquiaOuLine.length;
  const B = linhasResidual;

  console.log(`RESULTADO ESPERADO PELO BRIEFING: ~5 012 títulos mudam, 880 mantêm o prefixo`);
  console.log(`RESULTADO MEDIDO:`);
  console.log(`   títulos que mudam:                    ${totalMudam} de ${lidos}  (${pct(totalMudam, lidos)}%)`);
  console.log(`   mantêm o prefixo por colisão revertida: ${totalRevertidos}\n`);

  console.log(`A. TÍTULO LIMPO = NOME DA FRANQUIA OU LINE RESOLVIDA`);
  console.log(`   ${A} de ${lidos}  (${pct(A, lidos)}%)`);
  for (const e of igualFranquiaOuLine.slice(0, N_EXEMPLOS)) {
    console.log(`     ${e.sku}: "${e.title}" -> "${e.cleanTitle}"   [franquia=${e.franquia ?? "—"} line=${e.line ?? "—"}]`);
  }

  console.log(`\nB. COLISÕES RESIDUAIS (depois de resolveTitleCollisions já ter revertido o que dava)`);
  console.log(`   ${gruposResidual.length} grupo(s), ${B} linha(s)  (${pct(B, lidos)}%)`);
  const gruposOrdenados = [...gruposResidual].sort((a, b) => b.length - a.length);
  for (const g of gruposOrdenados.slice(0, N_EXEMPLOS)) {
    console.log(`     "${g[0].result}"  x${g.length}`);
    for (const item of g.slice(0, 5)) {
      const original = porSku.get(item.key);
      console.log(`         ${item.key}: "${original.title}"`);
    }
    if (g.length > 5) console.log(`         ... e mais ${g.length - 5}`);
  }

  console.log(`\n=== VEREDITO (briefing B0) ===`);
  console.log(`   A + B = ${A} + ${B} = ${A + B}`);
  if (A + B <= 20) {
    console.log(`   <= 20  ->  merge e deploy sem voltar atrás.`);
  } else {
    console.log(`   > 20  ->  PARAR outra vez. Residual acima do limiar.`);
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
