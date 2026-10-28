#!/usr/bin/env node
/**
 * PR 5 (28/10/2026) — vendor canónico só na criação. Num produto existente o ProductImporter não
 * reescreve o vendor; na criação usa o mapa canónico (resolveBrandDisplayName).
 * Uso: node scripts/tests/productimporter-vendor-canonico.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBrandDisplayName } from "../../lib/importer/catalog/brandDisplayNames.js";

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

check("produto existente: o input do productUpdate não tem vendor", () => {
  const bloco = src.slice(src.indexOf("const input = {"), src.indexOf("};", src.indexOf("const input = {")));
  assert.doesNotMatch(bloco, /vendor/);
});

check("criação: product.vendor usa o mapa canónico", () => {
  assert.match(src, /vendor: resolveBrandDisplayName\(record\.vendor\)\.name \|\| undefined/);
});

check("mapa canónico: vendor do feed em maiúsculas vira o nome canónico (Diamond Select)", () => {
  assert.equal(resolveBrandDisplayName("DIAMOND SELECT").name, "Diamond Select");
});

check("mapa P4 (28/10/2026): as quatro entradas do briefing resolvem para o nome canónico", () => {
  const esperado = {
    "TAMASHII NATIONS": "Tamashii Nations",
    "THE LOYAL SUBJECTS": "The Loyal Subjects",
    FUNKO: "Funko",
    HASBRO: "Hasbro",
  };
  for (const [feed, canonico] of Object.entries(esperado)) {
    const r = resolveBrandDisplayName(feed);
    assert.equal(r.name, canonico, feed);
    assert.equal(r.mapped, true, feed);
  }
});

console.log(failures ? `\nFALHOU — ${failures} falha(s)` : "\nOK — 0 falha(s)");
process.exitCode = failures ? 1 : 0;
