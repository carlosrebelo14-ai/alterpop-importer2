#!/usr/bin/env node
/**
 * 27/10/2026 — guarda da saída do fly-ops (log e artefacto públicos).
 * Proibido imprimir: precio_distribuidores, custo de fornecedor, margens, variáveis de
 * ambiente, morada ou nome do Carlos. Verifica os scripts do fly-ops e as bibliotecas que
 * eles chamam, linha a linha, nas chamadas console.*.
 * Uso: node scripts/tests/flyops-output-guard.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FILES = [
  "scripts/catalog/character-links-backfill.js",
  "scripts/catalog/character-census.js",
  "scripts/verify-character-invariants.js",
  "lib/importer/shopify/characterPagesSync.server.js",
  "lib/importer/shopify/characterPagesReconcileCycle.server.js",
  "lib/importer/catalog/characterPages.server.js",
  "lib/importer/catalog/productCharacterLinks.js",
  "lib/importer/shopify/productCharacterLinks.server.js",
  "lib/importer/catalog/characterInvariants.js",
];
const PROIBIDO = /precio_distribuidores|distributorPrice|grossPrice|netPrice|custo|cost\b|margin|margem|process\.env(?!\.SHOPIFY_SHOP_URL)|password|secret|token|morada|address|carlos/i;

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

for (const rel of FILES) {
  check(`${rel}: nenhuma chamada console imprime campo proibido`, () => {
    const lines = fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n");
    const bad = lines
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => /console\.(log|error|warn|info)\(/.test(l) && PROIBIDO.test(l));
    assert.deepEqual(
      bad.map(({ n, l }) => `${rel}:${n}: ${l.trim()}`),
      [],
      "linhas com campo proibido na saída",
    );
  });
}

console.log(failures ? `\nFALHOU — ${failures} falha(s)` : "\nOK — 0 falha(s)");
process.exitCode = failures ? 1 : 0;
