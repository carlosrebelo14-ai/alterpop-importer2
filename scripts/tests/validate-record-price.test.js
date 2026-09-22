#!/usr/bin/env node
/**
 * Auditoria 2026-09-22 — validateRecord()'s grossPrice<=0 check era incondicional,
 * ao contrário do seu espelho (netPrice), que só falha quando o OUTRO preço também
 * não cobre. Um SKU com precio_bruto='0' (frequente no feed OcioStock) e um
 * precio_neto válido era descartado do import inteiro, mesmo hasPrice já o
 * reconhecendo como válido e mesmo ProductImporter já cair para netPrice nesse
 * caso. Bateria espelha a de netPrice, que já se comportava bem.
 *
 * Uso: node scripts/tests/validate-record-price.test.js
 */
import assert from "node:assert/strict";
import { validateRecord } from "../../lib/importer/validation/validateRecord.js";

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

const BASE = { sku: "sku-1", title: "Produto Teste", availableQuantity: 5 };

check("grossPrice=0 com netPrice válido -> válido (bug corrigido)", () => {
  const { valid, errors } = validateRecord({ ...BASE, grossPrice: 0, netPrice: 15.5 });
  assert.equal(valid, true, `esperava válido, erros: ${JSON.stringify(errors)}`);
});

check("netPrice=0 com grossPrice válido -> válido (comportamento espelho, já existia)", () => {
  const { valid, errors } = validateRecord({ ...BASE, grossPrice: 12, netPrice: 0 });
  assert.equal(valid, true, `esperava válido, erros: ${JSON.stringify(errors)}`);
});

check("grossPrice=0 E netPrice=0 -> inválido (nenhum dos dois cobre)", () => {
  const { valid } = validateRecord({ ...BASE, grossPrice: 0, netPrice: 0 });
  assert.equal(valid, false);
});

check("grossPrice=0 e netPrice ausente -> inválido", () => {
  const { valid } = validateRecord({ ...BASE, grossPrice: 0, netPrice: null });
  assert.equal(valid, false);
});

check("grossPrice negativo continua sempre inválido, mesmo com netPrice válido", () => {
  const { valid, errors } = validateRecord({ ...BASE, grossPrice: -5, netPrice: 10 });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("cannot be negative")), `esperava erro de negativo, recebeu: ${JSON.stringify(errors)}`);
});

check("netPrice negativo continua sempre inválido, mesmo com grossPrice válido", () => {
  const { valid, errors } = validateRecord({ ...BASE, grossPrice: 10, netPrice: -5 });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("cannot be negative")), `esperava erro de negativo, recebeu: ${JSON.stringify(errors)}`);
});

check("ambos os preços válidos -> válido, sem erros de preço", () => {
  const { valid, errors } = validateRecord({ ...BASE, grossPrice: 12, netPrice: 10 });
  assert.equal(valid, true, `erros: ${JSON.stringify(errors)}`);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nvalidate-record-price: todos os casos passaram");
