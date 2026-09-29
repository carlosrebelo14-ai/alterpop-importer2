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
  rewriteVendorLink,
  onlyVendorLinkChanged,
  vendorLinkToken,
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

// ── ajuste de 29/09: link de marca na descrição ──

const DESC = (vendor) => buildProductDescriptionHtml({ sku: "X", title: "Luffy", vendor: "BANPRESTO" }).replace(/filter\.p\.vendor=Banpresto"/g, `filter.p.vendor=${encodeURIComponent(vendor)}"`);

await check("link — troca filter.p.vendor=BANPRESTO por filter.p.vendor=Banpresto, nada mais", () => {
  const before = DESC("BANPRESTO");
  const r = rewriteVendorLink(before, "BANPRESTO", "Banpresto");
  assert.equal(r.ok, true);
  assert.equal(r.replaced, 1);
  assert.ok(r.html.includes('filter.p.vendor=Banpresto"'));
  assert.equal(r.html.includes('filter.p.vendor=BANPRESTO"'), false);
  assert.equal(r.html.length, before.length);
});

await check("link — codificado: SD TOYS → SD%20Toys", () => {
  const r = rewriteVendorLink('<a href="/collections/all?filter.p.vendor=SD%20TOYS">x</a>', "SD TOYS", "SD Toys");
  assert.equal(r.html, '<a href="/collections/all?filter.p.vendor=SD%20Toys">x</a>');
});

await check("link — não toca num vendor mais longo com o mesmo início (FUNKO vs FUNKO%20SPAIN)", () => {
  const html = '<a href="?filter.p.vendor=FUNKO%20SPAIN">a</a><a href="?filter.p.vendor=FUNKO">b</a>';
  const r = rewriteVendorLink(html, "FUNKO", "Funko");
  assert.equal(r.html, '<a href="?filter.p.vendor=FUNKO%20SPAIN">a</a><a href="?filter.p.vendor=Funko">b</a>');
});

await check("link — descrição sem link: ok, nada a trocar", () => {
  assert.deepEqual(rewriteVendorLink("<p>x</p>", "FUNKO", "Funko"), { ok: true, html: "<p>x</p>", replaced: 0, reason: null });
});

await check("guarda — recusa se a descrição já tiver o link novo (troca ambígua)", () => {
  const r = rewriteVendorLink('<a href="?filter.p.vendor=FUNKO">a</a><a href="?filter.p.vendor=Funko">b</a>', "FUNKO", "Funko");
  assert.equal(r.ok, false);
  assert.match(r.reason, /ambígua/);
});

await check("guarda — recusa se a descrição mudar fora do link (substituição defeituosa injetada)", () => {
  const oldT = vendorLinkToken("FUNKO");
  const newT = vendorLinkToken("Funko");
  const original = `<p>Funko Pop</p><a href="?${oldT}>b</a>`;
  const tampered = `<p>FUNKO POP</p><a href="?${newT}>b</a>`;
  assert.equal(onlyVendorLinkChanged(original, tampered, oldT, newT), false);
  assert.equal(onlyVendorLinkChanged(original, original.split(oldT).join(newT), oldT, newT), true);
  const r = rewriteVendorLink(original, "FUNKO", "Funko", () => false);
  assert.equal(r.ok, false);
  assert.match(r.reason, /fora do link/);
});

await check("plano — produto recusado não entra (nem vendor nem descrição); os outros seguem", () => {
  const ok = P({ productId: "1", descriptionHtml: DESC("BANPRESTO") });
  const bad = P({ productId: "2", descriptionHtml: '<a href="?filter.p.vendor=BANPRESTO">a</a><a href="?filter.p.vendor=Banpresto">b</a>' });
  const plan = planVendorBackfill([ok, bad]);
  assert.deepEqual(plan.updates.map((u) => u.productId), ["1"]);
  assert.deepEqual(plan.refused.map((u) => u.productId), ["2"]);
  assert.equal(plan.processed, 2);
});

await check("plano — descriptionHtml só vai no input quando o link mudou", () => {
  const withLink = planVendorBackfill([P({ descriptionHtml: DESC("BANPRESTO") })]).updates[0];
  assert.ok(withLink.descriptionHtml.includes('filter.p.vendor=Banpresto"'));
  assert.equal(withLink.linksReplaced, 1);
  const noLink = planVendorBackfill([P({ descriptionHtml: "<p>x</p>" })]).updates[0];
  assert.equal(noLink.descriptionHtml, null);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nbrand-display-names: todos os casos passaram");
