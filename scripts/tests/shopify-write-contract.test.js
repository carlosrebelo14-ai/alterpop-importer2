#!/usr/bin/env node
/**
 * PR 4, decisão do arquiteto de 27/10/2026 — fixação do contrato de escrita na loja.
 * Cada ficheiro que chama productUpdate ou productSet tem de estar na lista de exceções
 * de docs/contrato-escrita-shopify.md. Ficheiro novo fora da lista = teste vermelho.
 * Uso: node scripts/tests/shopify-write-contract.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCAN_DIRS = ["lib", "scripts", "app", "server"];
const SKIP_DIRS = new Set(["node_modules", "tests"]);
const SELF = path.relative(ROOT, fileURLToPath(import.meta.url));

/** Exceções vivas, como em docs/contrato-escrita-shopify.md. */
export const PRODUCT_WRITE_ALLOWLIST = new Set([
  "lib/importer/shopify/shopifyProductPublisher.server.js",
  "lib/importer/importers/ProductImporter.js",
  "lib/importer/shopify/despublicacao.server.js",
  "scripts/catalog/vendor-backfill.js",
  "scripts/catalog/live-title-reconcile.js",
  "scripts/maintenance/backfill-product-descriptions-b15.mjs",
  "scripts/maintenance/fix-license-universe-links.mjs",
]);

/** Chamada ou campo de mutação, não leitura de resposta (`data.productUpdate.product`). */
const WRITE_RE = /productUpdate\s*\(|"productUpdate"|\bproductSet\s*\(|"productSet"/;

function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*");
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|mjs|jsx|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Ficheiros com chamadas executáveis a productUpdate / productSet (não comentários). */
export function findProductWriteFiles() {
  const hits = new Map();
  for (const d of SCAN_DIRS) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) {
      const rel = path.relative(ROOT, file);
      if (rel === SELF) continue;
      const lines = fs.readFileSync(file, "utf8").split("\n");
      const matched = lines.filter((l) => !isCommentLine(l) && WRITE_RE.test(l));
      if (matched.length) hits.set(rel, matched.length);
    }
  }
  return hits;
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

const hits = findProductWriteFiles();

check("todo o ficheiro com productUpdate/productSet está na lista de exceções", () => {
  const fora = [...hits.keys()].filter((f) => !PRODUCT_WRITE_ALLOWLIST.has(f));
  assert.deepEqual(fora, [], `ficheiros fora da lista: ${fora.join(", ")}`);
});

check("cada exceção ainda chama productUpdate (lista sem entradas mortas)", () => {
  const mortos = [...PRODUCT_WRITE_ALLOWLIST].filter((f) => !hits.has(f));
  assert.deepEqual(mortos, [], `exceções sem chamada: ${mortos.join(", ")}`);
});

check("nenhum productSet no código (criação continua em productCreate em PR 4)", () => {
  for (const d of SCAN_DIRS) {
    const abs = path.join(ROOT, d);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) {
      const rel = path.relative(ROOT, file);
      if (rel === SELF) continue;
      const bad = fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => !isCommentLine(l) && /\bproductSet\b/.test(l));
      assert.deepEqual(bad, [], `productSet em ${rel}`);
    }
  }
});

check("docs/contrato-escrita-shopify.md lista cada ficheiro da allowlist", () => {
  const doc = fs.readFileSync(path.join(ROOT, "docs", "contrato-escrita-shopify.md"), "utf8");
  const sem = [...PRODUCT_WRITE_ALLOWLIST].filter((f) => !doc.includes(path.basename(f)));
  assert.deepEqual(sem, [], `ficheiros não documentados: ${sem.join(", ")}`);
});

console.log(failures ? `\n${failures} falha(s)` : "\nok");
process.exitCode = failures ? 1 : 0;
