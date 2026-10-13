#!/usr/bin/env node
/**
 * B14 (briefing backend, 24/09/2026), secção 4 — accessScopesGuard.js.
 * Uso: node scripts/tests/access-scopes-guard.test.js
 */
import assert from "node:assert/strict";
import { checkAccessScopes, REQUIRED_PUBLISH_SCOPES, REQUIRED_THEME_SCOPES } from "../../lib/importer/shopify/accessScopesGuard.js";

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

check("guarda do tema (Decisão 32): exige só read_themes, nunca write_themes", () => {
  assert.deepEqual(REQUIRED_THEME_SCOPES, ["read_themes"]);
  assert.equal(checkAccessScopes(["read_products", "read_themes"], REQUIRED_THEME_SCOPES).ok, true);
  const missing = checkAccessScopes(["read_products", "write_products"], REQUIRED_THEME_SCOPES);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ["read_themes"]);
});

check("checkAccessScopes — ok com a lista completa", () => {
  const granted = [
    "read_customers",
    "write_customers",
    "read_publications",
    "write_publications",
    "read_products",
  ];
  const result = checkAccessScopes(granted, REQUIRED_PUBLISH_SCOPES);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

check("checkAccessScopes — falha com write_publications em falta (caso real: toml pede, loja não concedeu)", () => {
  const granted = ["read_customers", "read_publications", "read_products"];
  const result = checkAccessScopes(granted, REQUIRED_PUBLISH_SCOPES);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["write_publications"]);
});

check("checkAccessScopes — falha com os dois scopes de publicação em falta", () => {
  const result = checkAccessScopes(["read_products"], REQUIRED_PUBLISH_SCOPES);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["read_publications", "write_publications"]);
});

check("checkAccessScopes — lista de concedidos vazia/ausente não lança", () => {
  assert.equal(checkAccessScopes([], REQUIRED_PUBLISH_SCOPES).ok, false);
  assert.equal(checkAccessScopes(undefined, REQUIRED_PUBLISH_SCOPES).ok, false);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\naccess-scopes-guard: todos os casos passaram");
