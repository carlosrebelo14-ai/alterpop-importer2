#!/usr/bin/env node
/**
 * Tarefa 45 — censo da camada 2 do resolver (padrões de título).
 *
 * A Tarefa 11 (franchise-title-ref-contradiction.js) auditou os 12 395 produtos da
 * camada 1 (ref) e achou 28 contradições título/ref. A camada 2 (título puro, sem ref
 * a apontar para nenhum universo) nunca foi auditada — foi lá que a revisão do Carlos
 * ao lote piloto (v2) achou "Miniverse Potion classroom Make It Mini" → Harry Potter:
 * Miniverse é linha MGA Entertainment, sem licença Harry Potter; o token "potion"
 * disparou o padrão de título sem nenhuma ref a confirmar.
 *
 * SÓ RELATÓRIO — read-only, não escreve nada. Não decide quais tokens remover, só
 * dá o censo para a revisão humana decidir caso a caso (mesmo espírito da Tarefa 31,
 * title-prefix-census.js).
 *
 * Correr na Fly:  node scripts/catalog/franchise-layer2-audit.js
 *                 node scripts/catalog/franchise-layer2-audit.js --json
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { titleOnlyUniverse } from "../../lib/importer/catalog/franchiseResolver.server.js";

const args = process.argv.slice(2);
const AS_JSON = args.includes("--json");
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";
const PAGE = 500;
const SAMPLES_PER_TOKEN = 5;

async function main() {
  console.log(`\n=== franchise-layer2-audit (${SHOP}) — Tarefa 45 ===\n`);

  // token -> { count, universes: Map<universo, count>, samples: [{sku, title, universo}] }
  const byToken = new Map();
  let scanned = 0;
  let recomputeMismatch = 0;
  let cursor = null;

  for (;;) {
    const rows = await prisma.catalogProduct.findMany({
      where: { shop: SHOP, resolvedFranchiseLayer: 2 },
      select: { sku: true, title: true, titleSource: true, resolvedFranchise: true, resolvedLine: true },
      orderBy: [{ shop: "asc" }, { sku: "asc" }],
      take: PAGE,
      ...(cursor ? { cursor: { shop_sku: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;

    for (const r of rows) {
      scanned += 1;
      // Recalcula o hit de título puro — camada 2 pura é a resolução de universo por
      // título; quando o produto tem resolvedLine, a franchise pode ter vindo do
      // parent da Line (ver franchiseResolver.server.js resolveFranchise) e não do
      // título diretamente. Aqui reportamos sempre o token de título, mesmo quando a
      // Line acabou por decidir — é o mesmo texto que induziu a resolução, só que via
      // Line. O campo "via" no output distingue os dois casos.
      const titleHit = titleOnlyUniverse({ title: r.title, titleSource: r.titleSource }, {});
      if (!titleHit) {
        recomputeMismatch += 1; // não bateu de novo — Line decidiu sozinha, sem token de título direto
        continue;
      }

      const token = titleHit.matchedOn;
      let entry = byToken.get(token);
      if (!entry) {
        entry = { count: 0, universes: new Map(), samples: [] };
        byToken.set(token, entry);
      }
      entry.count += 1;
      entry.universes.set(r.resolvedFranchise, (entry.universes.get(r.resolvedFranchise) || 0) + 1);
      if (entry.samples.length < SAMPLES_PER_TOKEN) {
        entry.samples.push({ sku: r.sku, title: r.title, universo: r.resolvedFranchise, line: r.resolvedLine || null });
      }
    }

    cursor = { shop: SHOP, sku: rows[rows.length - 1].sku };
    if (rows.length < PAGE) break;
  }

  console.log(`produtos camada 2 analisados: ${scanned}`);
  console.log(`sem token de título ao recalcular (Line decidiu via parent): ${recomputeMismatch}`);
  console.log(`tokens distintos: ${byToken.size}\n`);

  // Achata para linhas token×universo, ordenado por contagem desc (spec: "por token,
  // descendente por contagem").
  const rows2 = [];
  for (const [token, entry] of byToken.entries()) {
    for (const [universo, count] of entry.universes.entries()) {
      rows2.push({ token, universo, count, totalToken: entry.count });
    }
  }
  rows2.sort((a, b) => b.count - a.count || a.token.localeCompare(b.token));

  console.log(`  ${"contagem".padStart(8)}  token disparador → universo`);
  for (const r of rows2) {
    console.log(`  ${String(r.count).padStart(8)}  "${r.token}" → ${r.universo}`);
  }

  console.log(`\n── amostra por token (${SAMPLES_PER_TOKEN} por token) ──`);
  const sortedTokens = [...byToken.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [token, entry] of sortedTokens) {
    console.log(`\n  "${token}" (${entry.count} produtos, ${entry.universes.size} universo(s)):`);
    entry.samples.forEach((s) =>
      console.log(`    ${s.sku}  → ${s.universo}${s.line ? ` / line ${s.line}` : ""}  "${s.title.slice(0, 70)}"`)
    );
  }

  console.log(`\n(nada escrito — só relatório. Corre em paralelo, não bloqueia o piloto.)`);

  if (AS_JSON) {
    const outDir = path.join(process.cwd(), "results");
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(outDir, `franchise-layer2-audit-${stamp}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify(
        { shop: SHOP, scanned, recomputeMismatch, tokens: rows2 },
        null,
        2
      )
    );
    console.log(`\nJSON: ${path.relative(process.cwd(), file)}`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err?.stack || err?.message || err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
