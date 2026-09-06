#!/usr/bin/env node
/**
 * Alteração 1 — parseFamilySignals separa os ref="..." do fornecedor dos tokens de
 * categoria livre. Valida também que parseFranchiseRefs (wrapper) não mudou de output.
 *
 * Uso: node scripts/tests/parse-family-signals.test.js
 */
import assert from "node:assert/strict";
import {
  parseFamilySignals,
  parseFranchiseRefs,
} from "../../lib/importer/connectors/ociostock/parseFamilies.js";

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

// Forma realista de xml_info_familias: <familia ref="..."> com <category> CDATA dentro.
const BLACK_CLOVER_XML =
  '<familias>' +
  '<familia ref="BLACKCLOVER"><category><![CDATA[ANIME / MANGA|BLACK CLOVER]]></category></familia>' +
  '<familia ref="FUNKO"><category><![CDATA[POP CULTURE COLLECTIBLES|FUNKO]]></category></familia>' +
  '</familias>';

const CONTEXT = {
  categoryRaw: "ANIME / MANGA|BLACK CLOVER",
  productTypeXml: '<campos product_type_path="FIGURAS Y REPLICAS|FIGURAS"></campos>',
};

check("franchiseRefs contém só os ref= do fornecedor", () => {
  const { franchiseRefs } = parseFamilySignals(BLACK_CLOVER_XML, CONTEXT);
  assert.deepEqual(franchiseRefs, ["BLACKCLOVER", "FUNKO"]);
});

check("franchiseRefs NÃO contém tokens de categoria", () => {
  const { franchiseRefs } = parseFamilySignals(BLACK_CLOVER_XML, CONTEXT);
  for (const noise of ["ANIME / MANGA", "BLACK CLOVER", "POP CULTURE COLLECTIBLES", "FIGURAS"]) {
    assert.ok(!franchiseRefs.includes(noise), `"${noise}" não devia estar em franchiseRefs`);
  }
});

check("categoryTokens recolhe o texto das categorias e do product_type_path", () => {
  const { categoryTokens } = parseFamilySignals(BLACK_CLOVER_XML, CONTEXT);
  assert.ok(categoryTokens.includes("BLACK CLOVER"));
  assert.ok(categoryTokens.includes("POP CULTURE COLLECTIBLES"));
  assert.ok(categoryTokens.includes("FIGURAS"));
  // os ref= não entram nos tokens de categoria
  assert.ok(!categoryTokens.includes("BLACKCLOVER"));
});

check("parseFranchiseRefs (wrapper) = refs seguidos dos tokens, sem duplicados", () => {
  const { franchiseRefs, categoryTokens } = parseFamilySignals(BLACK_CLOVER_XML, CONTEXT);
  const expected = [...new Set([...franchiseRefs, ...categoryTokens])];
  assert.deepEqual(parseFranchiseRefs(BLACK_CLOVER_XML, CONTEXT), expected);
});

check("sem xml_info_familias: franchiseRefs vazio, categoryTokens ainda vem do contexto", () => {
  const { franchiseRefs, categoryTokens } = parseFamilySignals("", CONTEXT);
  assert.deepEqual(franchiseRefs, []);
  assert.ok(categoryTokens.includes("BLACK CLOVER"));
});

check("entrada vazia total devolve dois arrays vazios", () => {
  assert.deepEqual(parseFamilySignals("", {}), { franchiseRefs: [], categoryTokens: [] });
});

if (failures) {
  console.error(`\n${failures} caso(s) falhados`);
  process.exit(1);
}
console.log("\nparse-family-signals: todos os casos passaram");
