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
await check("override da curadoria não substitui o custo: sem precio_distribuidores não é criado", async () => {
  const shop = makeShop();
  await q.setManualOverride("NEW-4", { price: 21 });
  await assert.rejects(() => publish(shop, "NEW-4", { distributorPrice: null }), /Sem precio_distribuidores/);
  assert.equal(shop.calls.filter((c) => c.name === "ProductCreate").length, 0);
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
await check("override da curadoria não reescreve um produto já publicado, e devolve o aviso", async () => {
  const shop = makeShop();
  shop.existing("EX-2", "19.90");
  await q.setManualOverride("EX-2", { price: 25 });
  const r1 = await publish(shop, "EX-2");
  await publish(shop, "EX-2");
  assert.equal(shop.price("EX-2"), "19.90");
  assert.equal(priceWrites(shop).length, 0);
  assert.match(r1.priceNotice, /não aplicado/);
});
await check("override com meio cêntimo (10.235) não gera aviso falso depois de criado a 10.23", async () => {
  const shop = makeShop();
  await q.setManualOverride("EX-7", { price: 10.235 });
  await publish(shop, "EX-7");
  assert.equal(shop.price("EX-7"), "10.23");
  const r = await publish(shop, "EX-7");
  assert.equal(r.priceNotice, null);
});
await check("produto existente a 0,00 recebe o preço da regra antes de publicar", async () => {
  const shop = makeShop();
  shop.existing("EX-3", "0.00");
  await publish(shop, "EX-3");
  assert.equal(shop.price("EX-3"), "17.50");
  assert.equal(shop.products.get("EX-3").publishedAt, "17.50");
});
await check("produto existente a 0,00 sem preço calculável: passa a DRAFT e recusa, sem preço escrito nem publicação", async () => {
  const shop = makeShop();
  shop.existing("EX-4", "0.00");
  await assert.rejects(() => publish(shop, "EX-4", { distributorPrice: null }), /não publicado a 0,00/);
  const updates = shop.calls.filter((c) => c.name === "ProductUpdate");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].vars.input.status, "DRAFT");
  assert.equal(shop.calls.filter((c) => ["VariantsBulkUpdate", "PublishablePublish"].includes(c.name)).length, 0);
});
await check("sync_locked a 0,00: recusado, nem preço escrito nem publicado", async () => {
  const shop = makeShop();
  shop.existing("EX-5", "0.00", { locked: true });
  await assert.rejects(() => publish(shop, "EX-5"), /trancado/);
  assert.equal(shop.calls.filter((c) => ["VariantsBulkUpdate", "PublishablePublish", "ProductUpdate"].includes(c.name)).length, 0);
});
await check("produto a 0,00 cuja escrita do preço falha: passa a DRAFT, não publicado", async () => {
  const shop = makeShop();
  shop.existing("EX-6", "0.00");
  shop.fail.variantWriteOnce = "Throttled";
  await assert.rejects(() => publish(shop, "EX-6"), /DRAFT/);
  const updates = shop.calls.filter((c) => c.name === "ProductUpdate");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].vars.input.status, "DRAFT");
  assert.equal(shop.calls.filter((c) => c.name === "PublishablePublish").length, 0);
});

console.log("Margem por produto");
// bulkSetMarginPct só muda SKUs já na fila (na loja estão todos lá desde o reindex).
const setMargin = async (sku, pct) => {
  if (!(await q.getCurationQueueEntry(sku))) await q.setManualOverride(sku, {});
  const r = await q.bulkSetMarginPct([sku], pct);
  assert.equal(r.updatedItems.length, 1);
};
await check("SKU fora da fila não é criado, volta em missing", async () => {
  const r = await q.bulkSetMarginPct(["NOT-IN-QUEUE"], 25);
  assert.equal(r.updatedItems.length, 0);
  assert.deepEqual(r.missing, ["NOT-IN-QUEUE"]);
  assert.equal(await q.getCurationQueueEntry("NOT-IN-QUEUE"), null);
});
await check("produto novo criado com a margem do produto (25 % → 15,50)", async () => {
  const shop = makeShop();
  await setMargin("MG-1", 25);
  await publish(shop, "MG-1");
  assert.equal(shop.price("MG-1"), "15.50");
});
await check("margem do produto reposta (null) volta à global (17,50)", async () => {
  const shop = makeShop();
  await setMargin("MG-2", 25);
  await setMargin("MG-2", null);
  assert.equal((await q.getCurationQueueEntry("MG-2")).metadata.overrides.marginPct, undefined);
  await publish(shop, "MG-2");
  assert.equal(shop.price("MG-2"), "17.50");
});
await check("margem do produto não reescreve um produto já publicado, e devolve o aviso", async () => {
  const shop = makeShop();
  shop.existing("MG-3", "17.50");
  await setMargin("MG-3", 25);
  const r = await publish(shop, "MG-3");
  assert.equal(shop.price("MG-3"), "17.50");
  assert.equal(priceWrites(shop).length, 0);
  assert.match(r.priceNotice, /Margem deste produto \(25 % → 15\.50\) não aplicada/);
});
await check("produto existente a 0,00 recebe o preço à margem do produto", async () => {
  const shop = makeShop();
  shop.existing("MG-4", "0.00");
  await setMargin("MG-4", 25);
  await publish(shop, "MG-4");
  assert.equal(shop.price("MG-4"), "15.50");
});
await check("margem do produto inválida na fila: não é criado", async () => {
  const shop = makeShop();
  await setMargin("MG-5", 25);
  const queue = await q.loadCurationQueue();
  queue.items.find((i) => i.sku === "MG-5").metadata.overrides.marginPct = 400;
  await q.saveCurationQueue(queue);
  await assert.rejects(() => publish(shop, "MG-5"), /Margem inválida/);
  assert.equal(shop.calls.filter((c) => c.name === "ProductCreate").length, 0);
});
await check("margem do produto convive com o preço fixado (o fixado manda) e com outros overrides", async () => {
  const shop = makeShop();
  await q.setManualOverride("MG-6", { price: 22, title: "Custom" });
  await setMargin("MG-6", 25);
  const ov = (await q.getCurationQueueEntry("MG-6")).metadata.overrides;
  assert.equal(ov.price, 22);
  assert.equal(ov.title, "Custom");
  await publish(shop, "MG-6");
  assert.equal(shop.price("MG-6"), "22.00");
});

await check("reindex de um PENDING mantém a margem do produto", async () => {
  await setMargin("MG-7", 25);
  const queue = await q.loadCurationQueue();
  queue.items.find((i) => i.sku === "MG-7").status = "PENDING";
  await q.saveCurationQueue(queue);
  await q.upsertCurationQueueFromRecord({ ...row("MG-7"), category: "Pop Culture", stock: 5 });
  assert.equal((await q.getCurationQueueEntry("MG-7")).metadata.overrides.marginPct, 25);
});

console.log("Fila — leituras simultâneas (OOM 09/10/2026)");
await check("50 leituras com a cache fria partilham uma só leitura do ficheiro", async () => {
  q.invalidateCurationMemoryCache();
  const all = await Promise.all(Array.from({ length: 50 }, () => q.loadCurationQueue()));
  assert.ok(all.every((x) => x === all[0]), "cada leitura parseou o ficheiro à parte");
});

await check("cópia em memória não relê o ficheiro quando outro processo o regrava", async () => {
  const a = await q.loadCurationQueue();
  const file = path.join(tmp, "curation-queue.json");
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later); // simula o flush do worker de indexação
  assert.equal(await q.loadCurationQueueCached(), a);
  assert.notEqual(await q.loadCurationQueue(), a);
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
