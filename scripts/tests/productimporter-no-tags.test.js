#!/usr/bin/env node
/**
 * 27/10/2026 — medição do consumidor 2: nenhuma tag de categoria tem leitor no tema
 * (alter-pop-theme-2.0). O ProductImporter deixa de escrever productType como tag.
 * productType continua no campo próprio. Uso: node scripts/tests/productimporter-no-tags.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = fs.readFileSync(path.join(ROOT, "lib/importer/importers/ProductImporter.js"), "utf8");

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

check("ProductImporter não escreve tags de productType", () => {
  assert.doesNotMatch(src, /tags:\s*productType/);
});

check("ProductImporter continua a escrever productType no campo próprio", () => {
  assert.match(src, /productType: productType \|\| undefined/);
});

console.log(failures ? `\nFALHOU — ${failures} falha(s)` : "\nOK — 0 falha(s)");
process.exitCode = failures ? 1 : 0;
