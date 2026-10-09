#!/usr/bin/env node
/**
 * "Aplicar aos publicados" — lista fechada de quem escreve preço na Shopify. Todo o ficheiro
 * que chama productVariantsBulkUpdate tem de gravar a última escrita (recordPriceWrite,
 * recordLastPriceWrites ou lastPriceWrite), senão o produto fica excluído do botão como
 * "sem última escrita" sem saída. Um ficheiro novo a escrever preço sem gravar falha aqui;
 * os que só mexem noutros campos da variante entram em NO_PRICE_WRITE, conscientemente.
 * Uso: node scripts/tests/price-write-records.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Chamam productVariantsBulkUpdate sem escrever preço. */
const NO_PRICE_WRITE = [
  "lib/importer/shopify/shopifyInventorySync.server.js", // só inventoryPolicy
  "scripts/curation/curation-spot-check.js", // só formata o log da resposta
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "tests") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|jsx|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FALHA  ${name}\n    ${err.message}`);
  }
}

const files = ["app", "lib", "scripts"].flatMap((d) => walk(path.join(ROOT, d))).map((f) => path.relative(ROOT, f));
const writers = files.filter((f) => /productVariantsBulkUpdate|productVariantUpdate|productVariantsBulkCreate/.test(fs.readFileSync(path.join(ROOT, f), "utf8")));

check("há escritores de preço conhecidos (o scan funciona)", () => {
  for (const f of [
    "lib/importer/shopify/shopifyProductPublisher.server.js",
    "lib/importer/importers/ProductImporter.js",
    "scripts/catalog/price-reconcile-apply.js",
  ]) assert.ok(writers.includes(f), `${f} devia aparecer no scan`);
});
check("todo o ficheiro que escreve preço grava a última escrita", () => {
  const missing = writers.filter((f) => {
    if (NO_PRICE_WRITE.includes(f)) return false;
    return !/recordPriceWrite|recordLastPriceWrites|lastPriceWrite/.test(fs.readFileSync(path.join(ROOT, f), "utf8"));
  });
  assert.deepEqual(missing, [], `escrevem preço sem gravar a última escrita (ou acrescentar a NO_PRICE_WRITE se não escrevem preço): ${missing.join(", ")}`);
});
check("as exceções continuam a existir (lista sem ficheiros mortos)", () => {
  for (const f of NO_PRICE_WRITE) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} já não existe — tirar de NO_PRICE_WRITE`);
});
check("as exceções não escrevem preço de facto", () => {
  for (const f of NO_PRICE_WRITE) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.ok(!/\bprice\s*:/.test(src.replace(/\/\/.*$/gm, "")), `${f} tem um campo price — já não é uma exceção`);
  }
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
