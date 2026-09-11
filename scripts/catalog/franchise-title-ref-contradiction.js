#!/usr/bin/env node
/**
 * BRIEFING BACKEND · Tarefa 11 — detetor de contradição título/ref.
 *
 * SÓ RELATÓRIO. Não escreve nada — alimenta a fila de curadoria (o operador decide
 * caso a caso; nenhuma franquia publicada muda por causa deste script).
 *
 * Sinaliza produtos onde a camada 1 (ref) resolveu um universo, mas o título — visto
 * SÓ pela camada 2, ignorando o ref — apontaria para um universo DIFERENTE. Caso de
 * referência: "Transformers ... Star Wars" (ref de um universo, token do outro no
 * título — inconsistência do fornecedor, não bug do resolver).
 *
 * Exclui os casos já resolvidos corretamente pela máquina de Lines (ex.: ref
 * "Mandalorian" → franchise "Star Wars" + line "The Mandalorian": aqui o título E o
 * ref apontam ambos para o mesmo sítio depois da Line entrar, não é contradição).
 *
 * Lê CatalogProduct.title/resolvedFranchise/resolvedFranchiseLayer/resolvedLine
 * diretamente da SQLite (node:sqlite, read-only) — mesmo padrão do
 * franchise-resolve-report.js, sem tocar em Prisma nem em Shopify.
 *
 * Correr na Fly:  node scripts/catalog/franchise-title-ref-contradiction.js
 *                 node scripts/catalog/franchise-title-ref-contradiction.js --json
 */
import fs from "node:fs";
import path from "node:path";
import { titleOnlyUniverse } from "../../lib/importer/catalog/franchiseResolver.server.js";
import { FRANCHISE_UNIVERSES } from "../../lib/importer/catalog/franchiseUniverses.js";
import { FRANCHISE_LINES } from "../../lib/importer/catalog/franchiseLines.js";

const args = process.argv.slice(2);
const AS_JSON = args.includes("--json");
const valOf = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const SHOP = valOf("--shop", process.env.SPOT_CHECK_SHOP || "jyr17t-wr.myshopify.com");

const HANDLE_BY_NAME = new Map(FRANCHISE_UNIVERSES.map((u) => [u.name, u.handle]));
const LINE_BY_NAME = new Map(FRANCHISE_LINES.map((l) => [l.line, l]));

async function main() {
  const dbPath = (process.env.DATABASE_URL || "").replace(/^file:/, "") || "./dev.sqlite";
  const { DatabaseSync } = await import("node:sqlite");
  const d = new DatabaseSync(dbPath, { readOnly: true });

  const rows = d
    .prepare(
      `SELECT sku, title, titleSource, resolvedFranchise, resolvedFranchiseLayer, resolvedLine
       FROM CatalogProduct WHERE shop = ? AND resolvedFranchiseLayer = 1`
    )
    .all(SHOP);
  d.close();

  const contradictions = [];
  let checked = 0;
  let lineExcused = 0;

  for (const r of rows) {
    checked += 1;
    const titleHit = titleOnlyUniverse(
      { title: r.title, titleSource: r.titleSource },
      {}
    );
    if (!titleHit) continue;

    const refHandle = HANDLE_BY_NAME.get(r.resolvedFranchise) || null;
    if (!refHandle || titleHit.handle === refHandle) continue;

    // Line já reconciliada: o título bate no parent da Line que o produto já leva.
    if (r.resolvedLine) {
      const line = LINE_BY_NAME.get(r.resolvedLine);
      const parentHandle = line ? HANDLE_BY_NAME.get(line.parent) : null;
      if (parentHandle && parentHandle === titleHit.handle) {
        lineExcused += 1;
        continue;
      }
    }

    contradictions.push({
      sku: r.sku,
      title: r.title,
      refFranchise: r.resolvedFranchise,
      refHandle,
      titleFranchise: titleHit.franchise,
      titleHandle: titleHit.handle,
      titleMatchedOn: titleHit.matchedOn,
    });
  }

  console.log(`\n=== franchise-title-ref-contradiction (${SHOP}) ===`);
  console.log(`produtos camada 1 (ref) analisados: ${checked}`);
  console.log(`excluídos por Line já reconciliada: ${lineExcused}`);
  console.log(`contradições: ${contradictions.length}\n`);

  if (contradictions.length) {
    console.log(`ref → universo A                título aponta → universo B          sku          título`);
    for (const c of contradictions) {
      console.log(
        `  ${c.refFranchise.padEnd(30)} → ${c.titleFranchise.padEnd(28)} ${c.sku.padEnd(12)} "${c.title.slice(0, 60)}"  (matchedOn: "${c.titleMatchedOn}")`
      );
    }
  } else {
    console.log("  ✓ nenhuma contradição título/ref encontrada.");
  }

  if (AS_JSON) {
    const outDir = path.join(process.cwd(), "results");
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(outDir, `franchise-title-ref-contradiction-${stamp}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({ shop: SHOP, checked, lineExcused, contradictions }, null, 2)
    );
    console.log(`\nJSON: ${path.relative(process.cwd(), file)}`);
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
