#!/usr/bin/env node
/**
 * BRIEFING passos 1-3 · Tarefa 1 — verificar que o publisher escreve `alterpop.line`.
 *
 * O código já está (PR #9): mapper leva `resolvedLine`, setProductMetafieldsSafe chama
 * setLineMetafield (NFC, salta se vazio). Este script prova o critério de saída pelo
 * CAMINHO REAL do publish (publishCatalogProductToShopify), não por um atalho.
 *
 * Dois produtos DESCARTÁVEIS, sintéticos (não tocam Prisma nem fila de curadoria):
 *   A: resolvedFranchise="Star Wars", resolvedLine="The Mandalorian"
 *      → espera alterpop.franchise=["Star Wars"] E alterpop.line=["The Mandalorian"]
 *      → espera pertença a star-wars E the-mandalorian
 *   B: resolvedFranchise="Star Wars", resolvedLine=null
 *      → espera SÓ alterpop.franchise; SEM alterpop.line
 *      → espera pertença a star-wars, NÃO a the-mandalorian
 *
 * Ambos apagados no fim (o publish cria+publica no Online Store; a limpeza é o delete).
 * Números do lado Shopify vêm de products(first:N), nunca de productsCount.
 *
 * Correr na Fla:
 *   node scripts/catalog/line-publish-verify.js
 *   node scripts/catalog/line-publish-verify.js --keep
 */
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { publishCatalogProductToShopify } from "../../lib/importer/shopify/shopifyProductPublisher.server.js";

const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const SHOP =
  (args.indexOf("--shop") >= 0 && args[args.indexOf("--shop") + 1]) ||
  process.env.SHOPIFY_SHOP_URL ||
  "jyr17t-wr.myshopify.com";

const stamp = Date.now();

function syntheticRow(suffix, resolvedFranchise, resolvedLine, title) {
  return {
    shop: SHOP,
    sku: `zzz-line-verify-${suffix}-${stamp}`,
    title,
    titleSource: "supplier", // não passa pela tradução
    vendor: "AlterpopTest",
    barcode: `zzzlv${suffix}${stamp}`,
    stock: 3,
    netPrice: 19.99,
    grossPrice: 24.19,
    franchises: "[]",
    franchiseRefs: "[]",
    categoryMain: "Figure",
    categorySegments: "[]",
    imageUrl: null,
    weightKg: 0.2,
    dimensions: null,
    hsCode: null,
    resolvedFranchise,
    resolvedFranchiseLayer: 1,
    resolvedLine,
  };
}

const PRODUCT_METAFIELDS = `
  query LV_Metafields($id: ID!) {
    product(id: $id) {
      id title status
      metafields(first: 30, namespace: "alterpop") { nodes { namespace key type value } }
    }
  }
`;
const COLLECTION_MEMBERS = `
  query LV_Coll($handle: String!) {
    collectionByHandle(handle: $handle) {
      handle templateSuffix
      ruleSet { rules { column relation condition } }
      products(first: 50) { nodes { id } }
    }
  }
`;
const PRODUCT_DELETE = `
  mutation LV_Delete($input: ProductDeleteInput!) {
    productDelete(input: $input) { deletedProductId userErrors { field message } }
  }
`;
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function main() {
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  console.log(`=== line-publish-verify (${SHOP}) ===\n`);

  const rows = [
    { key: "A", row: syntheticRow("A", "Star Wars", "The Mandalorian", `zzz-line-verify A Star Wars The Mandalorian Grogu [${stamp}]`), expectLine: true },
    { key: "B", row: syntheticRow("B", "Star Wars", null, `zzz-line-verify B Star Wars Darth Vader helmet [${stamp}]`), expectLine: false },
  ];

  const created = [];
  for (const r of rows) {
    const res = await publishCatalogProductToShopify(client, r.row, { metafieldReady: true });
    created.push({ ...r, id: res.shopifyProductId });
    console.log(`• ${r.key}  publicado: ${res.shopifyProductId}  (${res.action})`);
  }

  // 1. metafields no produto
  console.log(`\n── metafields (product.metafields, namespace alterpop) ──`);
  const results = [];
  for (const c of created) {
    const d = await client.graphql(PRODUCT_METAFIELDS, { id: c.id });
    const mfs = d.product?.metafields?.nodes || [];
    const franchise = mfs.find((m) => m.key === "franchise");
    const line = mfs.find((m) => m.key === "line");
    const okFranchise = franchise?.value === JSON.stringify(["Star Wars"]);
    const okLine = c.expectLine
      ? line?.value === JSON.stringify(["The Mandalorian"])
      : !line;
    results.push({ ...c, franchise, line, okFranchise, okLine });
    console.log(`  ${c.key}: franchise=${franchise?.value ?? "∅"}  line=${line?.value ?? "∅"}`);
    console.log(`     franchise ok: ${okFranchise ? "✓" : "✗"}   line ok: ${okLine ? "✓" : "✗"} (esperado ${c.expectLine ? '["The Mandalorian"]' : "ausente"})`);
  }

  // 2. pertença às coleções (polling até todas confirmadas)
  console.log(`\n── pertença às coleções (polling até 180s) ──`);
  let snap = {};
  for (let attempt = 1; attempt <= 18; attempt++) {
    await sleep(10);
    snap = {};
    for (const h of ["star-wars", "the-mandalorian"]) {
      const d = await client.graphql(COLLECTION_MEMBERS, { handle: h });
      const col = d.collectionByHandle;
      snap[h] = col ? { members: new Set((col.products?.nodes || []).map((n) => n.id)), rule: col.ruleSet?.rules?.[0], tpl: col.templateSuffix || "∅" } : null;
    }
    const a = created.find((c) => c.key === "A");
    const b = created.find((c) => c.key === "B");
    const settled =
      snap["star-wars"]?.members.has(a.id) &&
      snap["the-mandalorian"]?.members.has(a.id) &&
      snap["star-wars"]?.members.has(b.id);
    if (settled) { console.log(`  (regras avaliadas ao fim de ~${attempt * 10}s)`); break; }
    if (attempt === 18) console.log(`  (timeout 180s — estado atual)`);
  }

  console.log(`\n── resultado ──`);
  let pass = 0, fail = 0;
  for (const r of results) {
    const inSW = snap["star-wars"]?.members.has(r.id) || false;
    const inManda = snap["the-mandalorian"]?.members.has(r.id) || false;
    const expectManda = r.expectLine;
    const ok = r.okFranchise && r.okLine && inSW && (inManda === expectManda);
    console.log(`  ${ok ? "✓" : "✗"} ${r.key}  metafields[franchise=${r.okFranchise ? "ok" : "X"} line=${r.okLine ? "ok" : "X"}]  star-wars=${inSW}  the-mandalorian=${inManda} (esperado ${expectManda})`);
    ok ? pass++ : fail++;
  }
  console.log(`\n  star-wars       rule=${JSON.stringify(snap["star-wars"]?.rule)} tpl=${snap["star-wars"]?.tpl}`);
  console.log(`  the-mandalorian rule=${JSON.stringify(snap["the-mandalorian"]?.rule)} tpl=${snap["the-mandalorian"]?.tpl}`);
  console.log(`\n${pass} pass · ${fail} fail`);

  // 3. limpar
  if (KEEP) {
    console.log(`\n--keep: produtos ${created.map((c) => c.id).join(", ")} deixados na loja.`);
  } else {
    for (const c of created) {
      const d = await client.graphql(PRODUCT_DELETE, { input: { id: c.id } });
      console.log(`apagado ${c.key} ${c.id}: ${d.productDelete?.deletedProductId ? "✓" : "✗ " + JSON.stringify(d.productDelete?.userErrors)}`);
      await sleep(0.2);
    }
  }

  if (fail) process.exit(1);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
