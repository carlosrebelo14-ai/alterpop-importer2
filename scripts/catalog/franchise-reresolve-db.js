#!/usr/bin/env node
/**
 * ENTREGA 2 · Tarefa 5 — re-resolver a Prisma com a taxonomia nova (39 universos +
 * Lines). `resolvedFranchise`/`resolvedFranchiseLayer` estão persistidos com a
 * taxonomia antiga (41, com "The Mandalorian" e "Hello Kitty / Sanrio" como universos).
 *
 * Percorre TODOS os CatalogProduct em páginas por cursor (memória constante — a máquina
 * da Fly tem 512 MB), recalcula resolveFranchise({ franchiseRefs, title, titleSource })
 * e escreve resolvedFranchise / resolvedFranchiseLayer / resolvedLine.
 *
 * DRY-RUN por defeito: não escreve, só imprime a tabela de critérios de aceitação.
 * `--execute` aplica.
 *
 * Critérios de aceitação (ENTREGA 2):
 *   valores distintos de franquia            = 39   (ou menos, se algum não resolver nada)
 *   "The Mandalorian" como franquia          = 0
 *   registos com line = "The Mandalorian"    = 291
 *   Mandalorian com franchise = "Star Wars"  = 291
 *   "Hello Kitty / Sanrio" como franquia     = 0
 *
 * Precisa da Prisma (na Fly: /app/data/dev.sqlite). Correr na Fly.
 *   node scripts/catalog/franchise-reresolve-db.js
 *   node scripts/catalog/franchise-reresolve-db.js --execute
 */
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { resolveFranchise } from "../../lib/importer/catalog/franchiseResolver.server.js";

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
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
  const total = await prisma.catalogProduct.count({ where: { shop: SHOP } });
  console.log(`=== franchise-reresolve-db (${SHOP})${EXECUTE ? "" : " · DRY-RUN"} ===`);
  console.log(`CatalogProduct: ${total}`);

  let processed = 0;
  let changedFranchise = 0;
  let changedLine = 0;
  let writes = 0;

  const distinctAfter = new Map(); // franchise -> count
  let mandalorianAsFranchise = 0;
  let lineMandalorian = 0;
  let lineMandalorianParentSW = 0;
  let helloKittyAsFranchise = 0;
  let nowEmptyExHelloKitty = 0;
  let reassignedExHelloKitty = 0;
  let nowEmptyExMandalorian = 0;
  const examples = [];

  let cursor = null;
  for (;;) {
    const rows = await prisma.catalogProduct.findMany({
      where: { shop: SHOP },
      select: {
        shop: true, sku: true, title: true, titleSource: true, franchiseRefs: true,
        resolvedFranchise: true, resolvedFranchiseLayer: true, resolvedLine: true,
      },
      orderBy: [{ shop: "asc" }, { sku: "asc" }],
      take: PAGE,
      ...(cursor ? { cursor: { shop_sku: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;

    const updates = [];
    for (const r of rows) {
      const res = resolveFranchise({
        franchiseRefs: parseRefs(r.franchiseRefs),
        title: r.title || "",
        titleSource: r.titleSource ?? null,
      });
      const newFranchise = res.franchise ?? null;
      const newLayer = res.franchise ? res.layer : null;
      const newLine = res.line ?? null;

      if (newFranchise) distinctAfter.set(newFranchise, (distinctAfter.get(newFranchise) || 0) + 1);
      if (newFranchise === "The Mandalorian") mandalorianAsFranchise++;
      if (newFranchise === "Hello Kitty / Sanrio") helloKittyAsFranchise++;
      if (newLine === "The Mandalorian") {
        lineMandalorian++;
        if (newFranchise === "Star Wars") lineMandalorianParentSW++;
      }
      if (r.resolvedFranchise === "Hello Kitty / Sanrio") {
        if (!newFranchise) nowEmptyExHelloKitty++;
        else reassignedExHelloKitty++;
      }
      if (r.resolvedFranchise === "The Mandalorian" && !newFranchise && !newLine) {
        nowEmptyExMandalorian++;
      }

      const fChanged = (r.resolvedFranchise ?? null) !== newFranchise;
      const lChanged = (r.resolvedLine ?? null) !== newLine;
      if (fChanged) changedFranchise++;
      if (lChanged) changedLine++;
      if ((fChanged || lChanged) && examples.length < 40) {
        examples.push(
          `${r.sku}  "${(r.title || "").slice(0, 48)}"  [${r.resolvedFranchise ?? "∅"}/${r.resolvedLine ?? "∅"}] → [${newFranchise ?? "∅"}/${newLine ?? "∅"}]`
        );
      }
      if (fChanged || lChanged || (r.resolvedFranchiseLayer ?? null) !== newLayer) {
        updates.push({ shop: r.shop, sku: r.sku, newFranchise, newLayer, newLine });
      }
    }

    if (EXECUTE && updates.length) {
      await prisma.$transaction(
        updates.map((u) =>
          prisma.catalogProduct.update({
            where: { shop_sku: { shop: u.shop, sku: u.sku } },
            data: {
              resolvedFranchise: u.newFranchise,
              resolvedFranchiseLayer: u.newLayer,
              resolvedLine: u.newLine,
            },
          })
        )
      );
      writes += updates.length;
    }

    processed += rows.length;
    cursor = { shop: rows[rows.length - 1].shop, sku: rows[rows.length - 1].sku };
    if (processed % 5000 === 0 || rows.length < PAGE) {
      console.log(`  ${processed}/${total}…`);
    }
    if (rows.length < PAGE) break;
  }

  const distinctList = [...distinctAfter.entries()].sort((a, b) => b[1] - a[1]);

  console.log(`\n── resolução ──`);
  console.log(`processados            ${processed}`);
  console.log(`franquia alterada      ${changedFranchise}`);
  console.log(`line alterada          ${changedLine}`);
  console.log(`escritas               ${EXECUTE ? writes : "(dry-run)"}`);

  console.log(`\n── critérios de aceitação ──`);
  const row = (label, got, want) => {
    const ok = want === undefined ? " " : got === want ? "✓" : "✗";
    console.log(`  ${ok} ${label.padEnd(42)} ${String(got).padStart(5)}${want === undefined ? "" : `   (esperado ${want})`}`);
  };
  row("valores distintos de franquia", distinctList.length, 39);
  row('"The Mandalorian" como franquia', mandalorianAsFranchise, 0);
  row('registos com line = "The Mandalorian"', lineMandalorian, 291);
  row('  desses, com franchise = "Star Wars"', lineMandalorianParentSW, 291);
  row('"Hello Kitty / Sanrio" como franquia', helloKittyAsFranchise, 0);

  console.log(`\n── impacto Hello Kitty (Tarefa 3) ──`);
  row("ex-Hello Kitty agora SEM franquia", nowEmptyExHelloKitty);
  row("ex-Hello Kitty reatribuídos a outro universo", reassignedExHelloKitty);
  console.log(`\n── impacto Mandalorian ──`);
  row("ex-Mandalorian agora sem franquia NEM line (regressão!)", nowEmptyExMandalorian, 0);

  console.log(`\n── franquias distintas (${distinctList.length}) ──`);
  for (const [name, n] of distinctList) console.log(`  ${String(n).padStart(5)}  ${name}`);

  if (examples.length) {
    console.log(`\n── amostra de alterações (${examples.length}) ──`);
    for (const e of examples) console.log(`  ${e}`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err?.stack || err?.message || err);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
