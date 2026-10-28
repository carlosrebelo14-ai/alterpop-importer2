#!/usr/bin/env node
/* eslint-env node */
/**
 * Guarda do productCreate (28/10/2026): o input de criação só leva a tag `alterpop`.
 * Nenhuma tag de new-arrival, productType ou marca entra por tags. Uso:
 *   node scripts/tests/product-create-tags.test.js
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_URL = `file:${path.join(os.tmpdir(), "product-create-tags-unused.sqlite")}`;
const { buildShopifyProductTags, mapCatalogProductToShopifyPayload } = await import(
  path.join(process.cwd(), "lib/importer/shopify/shopifyMapper.server.js")
);
const { ALLOWED_PRODUCT_TAGS } = await import(path.join(process.cwd(), "lib/importer/shopify/tagAllowlist.js"));

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

const SO_ALTERPOP = ["alterpop"];

await check("lista permitida é só alterpop", () => {
  assert.deepEqual([...ALLOWED_PRODUCT_TAGS], SO_ALTERPOP);
});

await check("buildShopifyProductTags ignora customTags com new-arrival", () => {
  assert.deepEqual(buildShopifyProductTags("Funko", ["Star Wars"], ["new-arrival", "Premium"], {}), SO_ALTERPOP);
});

await check("buildShopifyProductTags ignora productType e marca como tag", () => {
  assert.deepEqual(buildShopifyProductTags("Hasbro", [], [], { productType: "Figures", tags: ["Hasbro", "Figures"] }), SO_ALTERPOP);
});

await check("payload de criação (graphql.product.tags) só leva alterpop, mesmo com customTags", async () => {
  const mapped = await mapCatalogProductToShopifyPayload(
    {
      sku: "TEST-SKU-1",
      title: "Teste",
      vendor: "Funko",
      franchises: JSON.stringify(["Star Wars"]),
      categoryMain: "Figures",
      status: "ACTIVE",
    },
    { customTags: ["new-arrival"] },
  );
  assert.deepEqual(mapped.graphql.product.tags, SO_ALTERPOP);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nproduct-create-tags: todos os casos passaram");
process.exit(0);
