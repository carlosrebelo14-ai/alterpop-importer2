#!/usr/bin/env node
/**
 * 27/10/2026 — o input de productCreate do publisher só pode levar tags de alterpop.
 * Se alguém voltar a pôr new-arrival, categorias ou marcas no input, este teste fica vermelho.
 * Uso: node scripts/tests/productcreate-tags.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildShopifyProductTags } from "../../lib/importer/shopify/shopifyMapper.server.js";
import { ALLOWED_PRODUCT_TAGS } from "../../lib/importer/shopify/tagAllowlist.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
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

check("buildShopifyProductTags só devolve tags de alterpop, com qualquer entrada", () => {
  const tags = buildShopifyProductTags("Jada Toys", ["Star Wars"], ["new-arrival"], { categoryMain: "Action Figures" });
  assert.deepEqual(tags, [...ALLOWED_PRODUCT_TAGS]);
});

check("publisher usa mapped.graphql.product.tags (sem tags próprias no createNewProduct)", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib/importer/shopify/shopifyProductPublisher.server.js"), "utf8");
  const create = src.slice(src.indexOf("async function createNewProduct"), src.indexOf("let cachedOnlineStorePublicationId"));
  assert.doesNotMatch(create, /tags\s*:/, "createNewProduct não pode montar tags à mão");
});

check("ProductImporter não escreve tags de productType nem de new-arrival", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib/importer/importers/ProductImporter.js"), "utf8");
  assert.doesNotMatch(src, /tags:\s*productType/);
  assert.doesNotMatch(src, /new-arrival/);
});

console.log(failures ? `\nFALHOU — ${failures} falha(s)` : "\nOK — 0 falha(s)");
process.exitCode = failures ? 1 : 0;
