#!/usr/bin/env node
/**
 * B5 — manufacturerTierResolver.server.js.
 * Uso: node scripts/tests/manufacturer-tier-resolver.test.js
 */
import assert from "node:assert/strict";
import { resolveManufacturerTier, isCollectibleVendor } from "../../lib/importer/catalog/manufacturerTierResolver.server.js";

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

check("fabricante da taxonomia resolve o tier certo", () => {
  assert.equal(resolveManufacturerTier("Funko"), "CORE");
  assert.equal(resolveManufacturerTier("Hot Toys"), "SIGNATURE");
  assert.equal(resolveManufacturerTier("Prime 1 Studio"), "ARTISAN");
  assert.equal(resolveManufacturerTier("Good Smile Company"), "COLLECTOR");
});

check("comparação insensível a caixa e pontuação (o feed escreve em maiúsculas)", () => {
  assert.equal(resolveManufacturerTier("FUNKO"), "CORE");
  assert.equal(resolveManufacturerTier("good smile company"), "COLLECTOR");
  assert.equal(resolveManufacturerTier("MCFARLANE TOYS"), "COLLECTOR");
});

check("fabricante fora da taxonomia fica SEM TIER, nunca CORE por omissão", () => {
  assert.equal(resolveManufacturerTier("Cerdá"), null);
  assert.equal(resolveManufacturerTier("Clementoni"), null);
  assert.equal(resolveManufacturerTier(""), null);
  assert.equal(resolveManufacturerTier(null), null);
  assert.equal(resolveManufacturerTier(undefined), null);
});

check("isCollectibleVendor — só COLLECTOR e CORE, nunca ARTISAN/SIGNATURE", () => {
  assert.equal(isCollectibleVendor("Funko"), true); // CORE
  assert.equal(isCollectibleVendor("NECA"), true); // COLLECTOR
  assert.equal(isCollectibleVendor("Hot Toys"), false); // SIGNATURE — fora do filtro por desenho
  assert.equal(isCollectibleVendor("Prime 1 Studio"), false); // ARTISAN — fora do filtro por desenho
  assert.equal(isCollectibleVendor("Cerdá"), false); // sem tier
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nmanufacturer-tier-resolver: todos os casos passaram");
