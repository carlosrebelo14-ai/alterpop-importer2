#!/usr/bin/env node
/**
 * Revisão adversarial do PR #87 — regra de preço do publisher, contra uma loja Shopify
 * falsa (sem rede) e uma fila temporária:
 *   - produto novo: preço da regra (ou o override da curadoria);
 *   - produto existente: o preço live nunca é reescrito (edição à mão, override antigo
 *     ou novo), SALVO quando está a 0,00 — aí escreve-se o da regra;
 *   - produto a 0,00 sem preço calculável: recusa antes de qualquer escrita/publicação;
 *   - criação interrompida e repetida no mesmo variantCache: nunca publicada a 0,00.
 * Uso: node scripts/tests/publisher-price-policy.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "publisher-price-policy-"));
process.env.CURATION_DATA_DIR = tmp;
process.env.DATABASE_URL = `file:${path.join(tmp, "x.sqlite")}`;

const q = await import("../../lib/curation/curationQueue.server.js");
const pub = await import("../../lib/importer/shopify/shopifyProductPublisher.server.js");

let failures = 0;
async function check(name, fn) {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    await fn();
    Object.assign(console, orig);
    console.log(`  ok  ${name}`);
  } catch (err) {
    Object.assign(console, orig);
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

/** Loja falsa: um produto por SKU, preço por variante, registo de chamadas. */
function makeShop() {
  const products = new Map();
  let n = 0;
  const calls = [];
  const fail = { variantWriteOnce: null };
  const client = {
    async graphql(query, vars = {}) {
      const name = (query.match(/(?:query|mutation)\s+(\w+)/) || [])[1];
      calls.push({ name, vars });
      switch (name) {
        case "ProductBySku": {
          const sku = vars.query.match(/sku:"(.*)"/)[1];
          const p = products.get(sku);
          if (!p) return { products: { nodes: [] } };
          return {
            products: {
              nodes: [
                {
                  id: p.id,
                  title: p.title,
                  syncLockedMetafield: p.locked ? { value: "true" } : null,
                  variants: { nodes: [{ id: p.variantId, sku, price: p.price, inventoryItem: null }] },
                },
              ],
            },
          };
        }
        case "ProductCreate": {
          n += 1;
          const p = { id: `gid://shopify/Product/${n}`, variantId: `gid://shopify/ProductVariant/${n}`, price: "0.00", title: vars.product.title };
          products.set(`__pending_${n}`, p);
          return { productCreate: { product: { id: p.id, title: p.title, variants: { nodes: [{ id: p.variantId, sku: null, inventoryItem: null }] } }, userErrors: [] } };
        }
        case "ProductUpdate":
          return { productUpdate: { product: { id: vars.input.id }, userErrors: [] } };
        case "VariantsBulkUpdate": {
          if (fail.variantWriteOnce) {
            const msg = fail.variantWriteOnce;
            fail.variantWriteOnce = null;
            throw new Error(msg);
          }
          const v = vars.variants[0];
          let entry;
          for (const [k, p] of products) if (p.id === vars.productId) entry = [k, p];
          const [key, p] = entry;
          if (v.price != null) p.price = v.price;
          const sku = v.inventoryItem?.sku;
          if (sku && key !== sku) {
            products.delete(key);
            products.set(sku, p);
          }
          return { productVariantsBulkUpdate: { productVariants: [{ id: v.id, sku, inventoryItem: null }], userErrors: [] } };
        }
        case "MetafieldsSet":
          return { metafieldsSet: { metafields: [], userErrors: [] } };
        case "GetPublications":
          return { publications: { nodes: [{ id: "gid://shopify/Publication/1", name: "Online Store" }] } };
        case "PublishablePublish": {
          for (const p of products.values()) if (p.id === vars.id) p.publishedAt = p.price;
          return { publishablePublish: { publishable: {}, userErrors: [] } };
        }
        case "ProductCreateMedia":
          return { productCreateMedia: { media: [], mediaUserErrors: [] } };
        default:
          return {};
      }
    },
  };
  const existing = (sku, price, extra = {}) => {
    n += 1;
    products.set(sku, { id: `gid://shopify/Product/${n}`, variantId: `gid://shopify/ProductVariant/${n}`, price, title: "x", ...extra });
  };
  return { client, products, calls, fail, existing, price: (sku) => products.get(sku)?.price };
}

const row = (sku, extra = {}) => ({
  shop: "test.myshopify.com",
  sku,
  title: "Test figure",
  titleSource: "supplier",
  vendor: "FUNKO",
  categoryMain: "Pop Culture",
  netPrice: 14.83,
  grossPrice: 17.95,
  distributorPrice: 9.99,
  stock: 5,
  franchises: "[]",
  ...extra,
});

const publish = (shop, sku, extra = {}, cache = new Map()) =>
  pub.publishCatalogProductToShopify(shop.client, row(sku, extra), { variantCache: cache, metafieldReady: false, marginPct: 40 });

const priceWrites = (shop) => shop.calls.filter((c) => c.name === "VariantsBulkUpdate" && c.vars.variants[0].price != null);

await q.saveCurationQueue({ version: 1, items: [] });

console.log("Produto novo");
await check("criado com o preço da regra (9,99 / 17,95 a 40 % → 17,50)", async () => {
  const shop = makeShop();
  await publish(shop, "NEW-1");
  assert.equal(shop.price("NEW-1"), "17.50");
});
await check("criado com o override da curadoria", async () => {
  const shop = makeShop();
  await q.setManualOverride("NEW-2", { price: 20 });
  await publish(shop, "NEW-2");
  assert.equal(shop.price("NEW-2"), "20.00");
});
await check("sem precio_distribuidores não é criado", async () => {
  const shop = makeShop();
  await assert.rejects(() => publish(shop, "NEW-3", { distributorPrice: null }), /Sem precio_distribuidores/);
  assert.equal(shop.calls.filter((c) => c.name === "ProductCreate").length, 0);
});

console.log("Produto existente");
await check("preço editado à mão fica (republish não escreve preço)", async () => {
  const shop = makeShop();
  shop.existing("EX-1", "19.90");
  await publish(shop, "EX-1");
  assert.equal(shop.price("EX-1"), "19.90");
  assert.equal(priceWrites(shop).length, 0);
});
await check("override da curadoria não reescreve um produto já publicado", async () => {
  const shop = makeShop();
  shop.existing("EX-2", "19.90");
  await q.setManualOverride("EX-2", { price: 25 });
  await publish(shop, "EX-2");
  await publish(shop, "EX-2");
  assert.equal(shop.price("EX-2"), "19.90");
  assert.equal(priceWrites(shop).length, 0);
});
await check("produto existente a 0,00 recebe o preço da regra antes de publicar", async () => {
  const shop = makeShop();
  shop.existing("EX-3", "0.00");
  await publish(shop, "EX-3");
  assert.equal(shop.price("EX-3"), "17.50");
  assert.equal(shop.products.get("EX-3").publishedAt, "17.50");
});
await check("produto existente a 0,00 sem preço calculável: recusa, nada escrito nem publicado", async () => {
  const shop = makeShop();
  shop.existing("EX-4", "0.00");
  await assert.rejects(() => publish(shop, "EX-4", { distributorPrice: null }), /não publicado a 0,00/);
  assert.equal(shop.calls.filter((c) => ["ProductUpdate", "VariantsBulkUpdate", "PublishablePublish"].includes(c.name)).length, 0);
});
await check("sync_locked a 0,00 não recebe escrita de preço (bloqueio vence)", async () => {
  const shop = makeShop();
  shop.existing("EX-5", "0.00", { locked: true });
  await publish(shop, "EX-5");
  assert.equal(priceWrites(shop).length, 0);
});

console.log("Criação interrompida");
await check("variante falha a seguir ao productCreate; retry no mesmo cache publica com preço", async () => {
  const shop = makeShop();
  const cache = new Map();
  shop.fail.variantWriteOnce = "401 Unauthorized";
  await assert.rejects(() => publish(shop, "INT-1", {}, cache), /401/);
  await publish(shop, "INT-1", {}, cache);
  const p = [...shop.products.values()].find((x) => x.publishedAt != null);
  assert.equal(p.publishedAt, "17.50");
  assert.equal(shop.calls.filter((c) => c.name === "ProductCreate").length, 1);
});

fs.rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
