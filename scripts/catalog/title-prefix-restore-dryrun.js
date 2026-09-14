#!/usr/bin/env node
/**
 * Averbamento à Decisão 17 (2026-09-14) · ponto 3 da spec — dry-run do prefixo de
 * formato reposto em FORMAT_PREFIXES.
 *
 * SÓ RELATÓRIO. Não escreve nada, em lado nenhum. O `--execute` do backfill
 * (title-clean-dryrun.js) só corre depois de estes números serem vistos.
 *
 * Traz o que a spec pede:
 *   1. quantos títulos mudam
 *   2. repartição por prefixo
 *   3. quantos a guarda travou (prefixo de formato sem `resolvedFormat` onde o guardar)
 *
 * E mais um que a spec não pediu mas que este PR obriga a olhar: repor a lista mexe
 * também no `stripFormatPrefix` que o franchiseResolver usa para construir o haystack
 * da camada de título. Isso pode mudar franquia/line resolvida, que é bem mais do que
 * limpar um título. Mede-se aqui — o `resolvedFranchise` guardado foi calculado no
 * ingest com a lista curta, por isso a comparação com o recálculo é um antes/depois
 * verdadeiro.
 *
 * Paginação por cursor (padrão da Tarefa 17 contra OOM — a máquina da Fly tem 512 MB).
 * Qualquer falha de leitura aborta com exit != 0 (Decisão 30).
 *
 * Correr na Fly:  node scripts/catalog/title-prefix-restore-dryrun.js
 *                 node scripts/catalog/title-prefix-restore-dryrun.js --exemplos 20
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { cleanProductTitleWithTrace } from "../../lib/importer/catalog/titleCleaner.server.js";
import {
  matchFormatPrefix,
  resolveFranchise,
} from "../../lib/importer/catalog/franchiseResolver.server.js";

const args = process.argv.slice(2);
const valOf = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const SHOP = valOf("--shop", process.env.SHOPIFY_SHOP_URL || "jyr17t-wr.myshopify.com");
const N_EXEMPLOS = parseInt(valOf("--exemplos", "10"), 10) || 10;
const PAGE = 500;

function parseRefs(raw) {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v.filter(Boolean) : [];
  } catch {
    return [];
  }
}

const pct = (parte, total) => (total ? ((parte / total) * 100).toFixed(2) : "0.00");

async function main() {
  const total = await prisma.catalogProduct.count({ where: { shop: SHOP } });
  console.log(`\n=== title-prefix-restore-dryrun (${SHOP}) — averbamento à Decisão 17 ===\n`);
  console.log(`CatalogProduct: ${total}\n`);

  let lidos = 0;
  let mudam = 0;
  let travados = 0;
  let semFormatoEComPrefixo = 0;
  const porPrefixo = new Map();
  const porPrefixoTravado = new Map();
  const exemplos = [];
  const exemplosTravados = [];

  // Efeito colateral no resolver
  let mudouFranquia = 0;
  let mudouLine = 0;
  const exemplosResolver = [];

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
          titleSource: true,
          franchiseRefs: true,
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
      const prefixo = matchFormatPrefix(r.title || "");
      const { result, firedRules } = cleanProductTitleWithTrace(r);

      if (firedRules.includes("prefixo-formato-travado")) {
        travados += 1;
        if (prefixo) porPrefixoTravado.set(prefixo, (porPrefixoTravado.get(prefixo) || 0) + 1);
        if (exemplosTravados.length < N_EXEMPLOS) {
          exemplosTravados.push({ sku: r.sku, title: r.title, prefixo });
        }
      }
      if (prefixo && !r.resolvedFormat) semFormatoEComPrefixo += 1;

      if (firedRules.includes("prefixo-formato") && prefixo) {
        porPrefixo.set(prefixo, (porPrefixo.get(prefixo) || 0) + 1);
      }

      if (result !== r.title) {
        mudam += 1;
        if (exemplos.length < N_EXEMPLOS) {
          exemplos.push({ sku: r.sku, antes: r.title, depois: result, regras: firedRules });
        }
      }

      // Efeito colateral: a mesma lista alimenta o haystack da camada de título.
      const res = resolveFranchise({
        franchiseRefs: parseRefs(r.franchiseRefs),
        title: r.title || "",
        titleSource: r.titleSource ?? null,
      });
      const novaFranquia = res.franchise ?? null;
      const novaLine = res.line ?? null;
      if (novaFranquia !== (r.resolvedFranchise ?? null)) {
        mudouFranquia += 1;
        if (exemplosResolver.length < N_EXEMPLOS) {
          exemplosResolver.push({
            sku: r.sku,
            title: r.title,
            antes: r.resolvedFranchise ?? "—",
            depois: novaFranquia ?? "—",
          });
        }
      }
      if (novaLine !== (r.resolvedLine ?? null)) mudouLine += 1;
    }

    cursor = { shop: SHOP, sku: rows[rows.length - 1].sku };
    if (rows.length < PAGE) break;
  }

  console.log(`1. TÍTULOS QUE MUDAM`);
  console.log(`   ${mudam} de ${lidos}  (${pct(mudam, lidos)}%)\n`);

  console.log(`2. REPARTIÇÃO POR PREFIXO (só onde o prefixo saiu mesmo)`);
  const ordenado = [...porPrefixo.entries()].sort((a, b) => b[1] - a[1]);
  if (!ordenado.length) console.log(`   (nenhum)`);
  for (const [prefixo, n] of ordenado) {
    console.log(`   ${String(n).padStart(6)}  ${pct(n, lidos).padStart(6)}%  ${prefixo}`);
  }

  console.log(`\n3. TRAVADOS PELA GUARDA (prefixo de formato sem resolvedFormat)`);
  console.log(`   ${travados} de ${lidos}  (${pct(travados, lidos)}%)`);
  const ordenadoT = [...porPrefixoTravado.entries()].sort((a, b) => b[1] - a[1]);
  for (const [prefixo, n] of ordenadoT) {
    console.log(`   ${String(n).padStart(6)}  ${prefixo}`);
  }
  console.log(`   (verificação cruzada — linhas com prefixo e sem formato: ${semFormatoEComPrefixo})`);

  console.log(`\n4. EFEITO COLATERAL NO RESOLVER (não pedido na spec, mas a lista é a mesma)`);
  console.log(`   resolvedFranchise muda: ${mudouFranquia}  (${pct(mudouFranquia, lidos)}%)`);
  console.log(`   resolvedLine muda:      ${mudouLine}  (${pct(mudouLine, lidos)}%)`);
  for (const e of exemplosResolver) {
    console.log(`     ${e.sku}: "${e.antes}" → "${e.depois}"   ${JSON.stringify(e.title)}`);
  }

  console.log(`\nEXEMPLOS DE TÍTULO (${exemplos.length})`);
  for (const e of exemplos) {
    console.log(`  ${e.sku}  [${e.regras.join(", ")}]`);
    console.log(`    antes : "${e.antes}"`);
    console.log(`    depois: "${e.depois}"`);
  }

  if (exemplosTravados.length) {
    console.log(`\nEXEMPLOS TRAVADOS PELA GUARDA (${exemplosTravados.length})`);
    for (const e of exemplosTravados) {
      console.log(`  ${e.sku}  prefixo "${e.prefixo}" fica — sem resolvedFormat onde o guardar`);
      console.log(`    "${e.title}"`);
    }
  }

  console.log(`\n(nada escrito — dry-run.)\n`);
}

main()
  .catch((err) => {
    console.error(`\n${err?.stack || err?.message || err}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
