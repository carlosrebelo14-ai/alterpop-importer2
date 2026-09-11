#!/usr/bin/env node
/**
 * BRIEFING BACKEND · Tarefa 10 — titleCleaner.server.js.
 * Uso: node scripts/tests/title-cleaner.test.js
 */
import assert from "node:assert/strict";
import { cleanProductTitle } from "../../lib/importer/catalog/titleCleaner.server.js";

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

check("remove prefixo de formato conhecido", () => {
  assert.equal(
    cleanProductTitle({ title: "POP figure Darth Vader", resolvedFranchise: null }),
    "Darth Vader"
  );
});

check("remove preço/moeda embutido", () => {
  assert.equal(
    cleanProductTitle({ title: "Star Wars Darth Vader figure 12,99€", resolvedFranchise: "Star Wars" }),
    "Star Wars Darth Vader figure"
  );
  assert.equal(
    cleanProductTitle({ title: "Batman mug $19.99 clearance", resolvedFranchise: "Batman" }),
    "Batman mug clearance"
  );
});

check("colapsa franquia repetida, mantém a 1.ª ocorrência", () => {
  assert.equal(
    cleanProductTitle({ title: "Star Wars Grogu Star Wars figure", resolvedFranchise: "Star Wars" }),
    "Star Wars Grogu figure"
  );
});

check("sem franquia resolvida: não mexe em repetições", () => {
  assert.equal(
    cleanProductTitle({ title: "Funko Funko Pop assorted", resolvedFranchise: null }),
    "Funko Funko Pop assorted"
  );
});

check("normaliza espaços e pontuação órfã nas pontas", () => {
  assert.equal(
    cleanProductTitle({ title: "  - Frozen   Elsa doll -  ", resolvedFranchise: "Frozen" }),
    "Frozen Elsa doll"
  );
});

check("título sem alterações fica igual (idempotente)", () => {
  const t = "Harry Potter Hedwig plush 25cm";
  assert.equal(cleanProductTitle({ title: t, resolvedFranchise: "Harry Potter" }), t);
});

check("título vazio não rebenta", () => {
  assert.equal(cleanProductTitle({ title: "", resolvedFranchise: null }), "");
  assert.equal(cleanProductTitle({}), "");
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\ntitle-cleaner: todos os casos passaram");
