#!/usr/bin/env node
/**
 * C2 (briefing 29/09/2026) — nome de marca para o cliente (BRAND_DISPLAY_NAMES).
 * A chave continua a ser o vendor do feed; o nome do mapa só na fronteira da Shopify.
 * Uso: node scripts/tests/brand-display-names.test.js
 */
import assert from "node:assert/strict";
import {
  BRAND_DISPLAY_NAMES,
  brandKey,
  resolveBrandDisplayName,
  planVendorBackfill,
} from "../../lib/importer/catalog/brandDisplayNames.js";
import {
  mapCatalogProductToShopifyPayload,
  buildProductDescriptionHtml,
  buildPublishPayload,
} from "../../lib/importer/shopify/shopifyMapper.server.js";
import {
  checkVendorUnmapped,
  runPrePublishChecks,
  PRE_PUBLISH_CHECKS,
} from "../../lib/importer/curation/prePublishChecks.server.js";

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

// ── mapa ──

await check("mapa inicial do briefing — 12 marcas", () => {
  assert.equal(Object.keys(BRAND_DISPLAY_NAMES).length, 12);
});

await check("SD TOYS → SD Toys (nunca Title Case automático, que daria \"Sd Toys\")", () => {
  assert.deepEqual(resolveBrandDisplayName("SD TOYS"), { key: "SD TOYS", name: "SD Toys", mapped: true });
});

await check("chave tolera espaços e maiúsculas do feed", () => {
  assert.equal(brandKey("  bandai   hobby "), "BANDAI HOBBY");
  assert.equal(resolveBrandDisplayName("bandai hobby").name, "Bandai Hobby");
});

await check("vendor desconhecido → fora do mapa, fica o valor do feed", () => {
  assert.deepEqual(resolveBrandDisplayName("TAMASHII NATIONS"), { key: "TAMASHII NATIONS", name: "TAMASHII NATIONS", mapped: false });
});

await check("sem vendor → sem nome", () => {
  assert.equal(resolveBrandDisplayName(null).name, null);
  assert.equal(resolveBrandDisplayName("  ").name, null);
});

// ── VENDOR_UNMAPPED ──

await check("VENDOR_UNMAPPED — vendor desconhecido dispara, com o valor do feed", () => {
  const w = checkVendorUnmapped({ vendor: "TAMASHII NATIONS" });
  assert.equal(w?.code, "VENDOR_UNMAPPED");
  assert.equal(w.evidence.vendor, "TAMASHII NATIONS");
});

await check("VENDOR_UNMAPPED — vendor do mapa e produto sem vendor não disparam", () => {
  assert.equal(checkVendorUnmapped({ vendor: "BANPRESTO" }), null);
  assert.equal(checkVendorUnmapped({ vendor: null }), null);
});

await check("VENDOR_UNMAPPED — está em PRE_PUBLISH_CHECKS e chega pelo agregador", () => {
  assert.equal(PRE_PUBLISH_CHECKS.includes(checkVendorUnmapped), true);
  const codes = runPrePublishChecks({ sku: "X", title: "Goku", vendor: "TAMASHII NATIONS", resolvedFranchise: "Dragon Ball", resolvedFormat: "Action Figure", descriptionHtml: "" }).map((w) => w.code);
  assert.deepEqual(codes, ["VENDOR_UNMAPPED"]);
});

// ── publisher / descrição: nome do mapa só na fronteira ──

const ROW = { sku: "4983164893458", title: "One Piece Luffy Ichibansho", vendor: "BANPRESTO", titleSource: "supplier" };

await check("publisher — campo vendor do produto (graphql e REST) leva o nome do mapa", async () => {
  const m = await mapCatalogProductToShopifyPayload(ROW);
  assert.equal(m.vendor, "Banpresto");
  assert.equal(m.graphql.product.vendor, "Banpresto");
  assert.equal(m.restProduct.product.vendor, "Banpresto");
});

await check("publisher — a chave do feed continua disponível (sourceVendor) e no payload interno", async () => {
  const m = await mapCatalogProductToShopifyPayload(ROW);
  assert.equal(m.sourceVendor, "BANPRESTO");
  assert.equal((await buildPublishPayload(ROW)).vendor, "BANPRESTO");
});

await check("publisher — vendor fora do mapa publica com o valor do feed", async () => {
  const m = await mapCatalogProductToShopifyPayload({ ...ROW, vendor: "TAMASHII NATIONS" });
  assert.equal(m.vendor, "TAMASHII NATIONS");
});

await check("descrição — texto e link filter.p.vendor com o nome do mapa (bate com o campo vendor)", () => {
  const html = buildProductDescriptionHtml({ sku: "X", title: "Luffy", vendor: "BANPRESTO" });
  assert.ok(html.includes("filter.p.vendor=Banpresto"), "link com o nome do mapa");
  assert.equal(html.includes("BANPRESTO"), false, "nunca o valor do feed ao cliente");
});

await check("descrição — o tier do fabricante continua a sair da chave do feed", () => {
  // Mesmo texto que antes do C2 para o tier; só o nome mostrado muda.
  const withKey = buildProductDescriptionHtml({ sku: "X", title: "Luffy", vendor: "BANPRESTO" });
  const withDisplay = buildProductDescriptionHtml({ sku: "X", title: "Luffy", vendor: "Banpresto" });
  assert.equal(withKey, withDisplay);
});

// ── plano do vendor-backfill ──

const P = (over) => ({ productId: "1", handle: "h", sku: "S", liveVendor: "BANPRESTO", feedVendor: "BANPRESTO", syncLocked: false, ...over });

await check("backfill — BANPRESTO live passa a Banpresto", () => {
  const plan = planVendorBackfill([P()]);
  assert.deepEqual(plan.updates.map((u) => [u.from, u.to]), [["BANPRESTO", "Banpresto"]]);
});

await check("backfill — idempotente: já com o nome do mapa não entra", () => {
  assert.equal(planVendorBackfill([P({ liveVendor: "Banpresto" })]).alreadyOk, 1);
});

await check("backfill — fora do mapa não toca (VENDOR_UNMAPPED)", () => {
  const plan = planVendorBackfill([P({ liveVendor: "TAMASHII NATIONS", feedVendor: "TAMASHII NATIONS" })]);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.unmapped.length, 1);
});

await check("backfill — sync_locked de fora sem includeLocked; entra com includeLocked", () => {
  assert.equal(planVendorBackfill([P({ syncLocked: true })]).lockedSkipped.length, 1);
  assert.equal(planVendorBackfill([P({ syncLocked: true })], { includeLocked: true }).updates.length, 1);
});

await check("backfill — a chave é o vendor do feed (Prisma), não o live; processed = total", () => {
  const plan = planVendorBackfill([P({ liveVendor: "Sd Toys", feedVendor: "SD TOYS" }), P({ productId: "2", liveVendor: null, feedVendor: null })]);
  assert.deepEqual(plan.updates.map((u) => u.to), ["SD Toys"]);
  assert.equal(plan.noVendor, 1);
  assert.equal(plan.processed, 2);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nbrand-display-names: todos os casos passaram");
