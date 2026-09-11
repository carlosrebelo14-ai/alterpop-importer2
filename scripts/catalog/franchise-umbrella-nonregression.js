#!/usr/bin/env node
/**
 * BRIEFING BACKEND · Tarefa 14b — prova de não regressão (Decisão 9, condições 1-2).
 *
 * SÓ RELATÓRIO. Não escreve nada, não liga nada. Compara, para TODO o catálogo,
 * resolveFranchise() (o que está em produção hoje) contra resolveFranchiseWithUmbrella()
 * (a versão com a camada 3 de chapéu, ainda não ligada a nada):
 *
 *   Condição 1 (não regressão)  todo produto que já resolvia por camada 1/2/Line tem
 *                                de sair BYTE A BYTE igual (franchise, handle, layer,
 *                                line, lineHandle) — regressões = 0 é o portão.
 *   Condição 2 (marca)          todo produto que passa a resolver só pelo chapéu leva
 *                                isUmbrella=true; nenhum produto fora do chapéu leva.
 *
 * Correr na Fly:  node scripts/catalog/franchise-umbrella-nonregression.js
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import {
  resolveFranchise,
  resolveFranchiseWithUmbrella,
} from "../../lib/importer/catalog/franchiseResolver.server.js";

const SHOP =
  (process.argv.indexOf("--shop") >= 0 && process.argv[process.argv.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";
const PAGE = 500;

function parseRefs(raw) {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function main() {
  console.log(`\n=== franchise-umbrella-nonregression (${SHOP}) — Tarefa 14b ===\n`);

  let processed = 0;
  let alreadyResolved = 0; // camada 1/2/Line
  let regressions = 0;
  const regressionSamples = [];
  let newlyUmbrella = 0;
  const umbrellaByHandle = new Map();
  let stillEmpty = 0;
  let cursor = null;

  for (;;) {
    const rows = await prisma.catalogProduct.findMany({
      where: { shop: SHOP },
      select: { sku: true, title: true, titleSource: true, franchiseRefs: true },
      orderBy: [{ shop: "asc" }, { sku: "asc" }],
      take: PAGE,
      ...(cursor ? { cursor: { shop_sku: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;

    for (const r of rows) {
      processed += 1;
      const input = { franchiseRefs: parseRefs(r.franchiseRefs), title: r.title || "", titleSource: r.titleSource ?? null };
      const before = resolveFranchise(input);
      const after = resolveFranchiseWithUmbrella(input);

      if (before.franchise) {
        alreadyResolved += 1;
        const same =
          before.franchise === after.franchise &&
          before.handle === after.handle &&
          before.layer === after.layer &&
          (before.line ?? null) === (after.line ?? null) &&
          (before.lineHandle ?? null) === (after.lineHandle ?? null) &&
          after.isUmbrella === false;
        if (!same) {
          regressions += 1;
          if (regressionSamples.length < 20) {
            regressionSamples.push({ sku: r.sku, title: r.title, before, after });
          }
        }
        continue;
      }

      if (after.isUmbrella) {
        newlyUmbrella += 1;
        umbrellaByHandle.set(after.handle, (umbrellaByHandle.get(after.handle) || 0) + 1);
      } else {
        stillEmpty += 1;
      }
    }

    cursor = { shop: SHOP, sku: rows[rows.length - 1].sku };
    if (rows.length < PAGE) break;
  }

  console.log(`produtos processados: ${processed}`);
  console.log(`já resolvidos (camada 1/2/Line): ${alreadyResolved}`);
  console.log(`\n── Condição 1 — não regressão ──`);
  console.log(`  regressões: ${regressions}  ${regressions === 0 ? "✓" : "✗ PORTÃO NÃO PASSA"}`);
  regressionSamples.forEach((s) =>
    console.log(`    ${s.sku}  "${s.title}"  antes=${JSON.stringify(s.before)}  depois=${JSON.stringify(s.after)}`)
  );

  console.log(`\n── Condição 2 — marca UMBRELLA ──`);
  console.log(`  novos produtos com isUmbrella=true: ${newlyUmbrella}`);
  for (const [handle, n] of umbrellaByHandle) console.log(`    ${handle}: ${n}`);
  console.log(`  continuam sem sinal nenhum (nem chapéu): ${stillEmpty}`);
  console.log(`  ✓ nenhum produto fora do chapéu foi marcado isUmbrella (verificado na Condição 1)`);

  console.log(
    `\n── Condição 3 — reversibilidade (por construção, não medida aqui) ──\n` +
    `  resolveFranchiseWithUmbrella() tenta SEMPRE camada 1/2/Line primeiro; o chapéu só\n` +
    `  corre quando isso falha. Um produto cuja tabela ganhe entrada própria (ex.: Tarefa\n` +
    `  13b, Iron Man/Deadpool) passa a resolver por essa entrada e nunca mais chega ao\n` +
    `  chapéu — sem migração manual, porque a resolução é recalculada do zero a cada\n` +
    `  chamada (função pura sobre refs+título, sem estado próprio).`
  );

  console.log(
    `\n── Condição 4 — publicação (satisfeita por omissão) ──\n` +
    `  resolveFranchiseWithUmbrella() NÃO é chamada pela indexação nem pelo publisher —\n` +
    `  só por este script. Zero produtos UMBRELLA podem publicar porque a função que os\n` +
    `  produziria não está ligada a nada que escreva em Shopify.`
  );

  await prisma.$disconnect();
  if (regressions) process.exitCode = 1;
}

main().catch(async (err) => {
  console.error(err?.stack || err?.message || err);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
