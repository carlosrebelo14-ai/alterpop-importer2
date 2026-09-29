#!/usr/bin/env node
/**
 * B18 (briefing backend, 17/09/2026) — prePublishChecks.server.js.
 * Casos reais da auditoria do live (jyr17t-wr, 17/09/2026).
 * Uso: node scripts/tests/pre-publish-checks.test.js
 */
import assert from "node:assert/strict";
import {
  checkTitleDuplicate,
  checkPrefixResidue,
  checkMissingFranchise,
  checkFranchiseUnknown,
  findUnknownFranchiseValues,
  checkMissingFormat,
  checkSupplierTokens,
  checkVendorUnmapped,
  checkPriceRule,
  runPrePublishChecks,
  normalizeTitleForDuplicate,
  PRE_PUBLISH_CHECKS,
} from "../../lib/importer/curation/prePublishChecks.server.js";

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

// ── TITLE_DUPLICATE — caso real: "Star Wars Luke Skywalker", SKUs 889698675369 e 889698837972 ──

check("TITLE_DUPLICATE — dispara contra um produto ACTIVE com o mesmo título", () => {
  const payload = { sku: "889698675369", title: "Star Wars Luke Skywalker" };
  const context = { activeProducts: [{ sku: "889698837972", title: "Star Wars Luke Skywalker" }] };
  const result = checkTitleDuplicate(payload, context);
  assert.equal(result?.code, "TITLE_DUPLICATE");
  assert.equal(result.evidence.collisions[0].sku, "889698837972");
});

check("TITLE_DUPLICATE — dispara contra outro item do lote em aprovação", () => {
  const payload = { sku: "A", title: "Star Wars Luke Skywalker" };
  const context = { batch: [{ sku: "B", title: "star wars   luke skywalker" }] };
  const result = checkTitleDuplicate(payload, context);
  assert.equal(result?.code, "TITLE_DUPLICATE");
  assert.equal(result.evidence.collisions[0].source, "batch");
});

check("TITLE_DUPLICATE — comparação NFC, minúsculas, espaços colapsados", () => {
  assert.equal(normalizeTitleForDuplicate("  Pokémon   Pikachu  "), "pokémon pikachu");
  assert.equal(normalizeTitleForDuplicate("POKÉMON PIKACHU"), "pokémon pikachu");
});

check("TITLE_DUPLICATE — não dispara contra si próprio (mesmo SKU)", () => {
  const payload = { sku: "889698675369", title: "Star Wars Luke Skywalker" };
  const context = { activeProducts: [{ sku: "889698675369", title: "Star Wars Luke Skywalker" }] };
  assert.equal(checkTitleDuplicate(payload, context), null);
});

check("TITLE_DUPLICATE — não dispara sem colisão", () => {
  const payload = { sku: "A", title: "Star Wars Luke Skywalker" };
  const context = { activeProducts: [{ sku: "B", title: "Star Wars Darth Vader" }] };
  assert.equal(checkTitleDuplicate(payload, context), null);
});

// ── PREFIX_RESIDUE — caso real: "Rides Star Wars Luke Skywalker in T-47 Airspeeder Exclusive" (SKU 889698744041) ──

check("PREFIX_RESIDUE — dispara no caso real (\"Rides\", achado nesta auditoria)", () => {
  const result = checkPrefixResidue({ title: "Rides Star Wars Luke Skywalker in T-47 Airspeeder Exclusive" });
  assert.equal(result?.code, "PREFIX_RESIDUE");
  assert.equal(result.evidence.prefix, "Rides");
});

check("PREFIX_RESIDUE — dispara também para prefixos de FORMAT_PREFIXES (não só NOISE_PREFIXES)", () => {
  const result = checkPrefixResidue({ title: "POP figure Pikachu" });
  assert.equal(result?.code, "PREFIX_RESIDUE");
});

check("PREFIX_RESIDUE — não dispara em título limpo", () => {
  assert.equal(checkPrefixResidue({ title: "Star Wars Luke Skywalker" }), null);
});

// ── MISSING_FRANCHISE / MISSING_FORMAT ──

check("MISSING_FRANCHISE — dispara sem universo resolvido", () => {
  assert.equal(checkMissingFranchise({ resolvedFranchise: null })?.code, "MISSING_FRANCHISE");
  assert.equal(checkMissingFranchise({ resolvedFranchise: "Star Wars" }), null);
});

check("MISSING_FORMAT — dispara sem formato resolvido", () => {
  assert.equal(checkMissingFormat({ resolvedFormat: null })?.code, "MISSING_FORMAT");
  assert.equal(checkMissingFormat({ resolvedFormat: "Figure" }), null);
});

// ── SUPPLIER_TOKENS — caso real: descrições de 15/09 (B15) ──

check("SUPPLIER_TOKENS — dispara com tokens internos do feed na descrição", () => {
  const result = checkSupplierTokens({ descriptionHtml: "<p>License / Universe: Xoff, Relojes</p>" });
  assert.equal(result?.code, "SUPPLIER_TOKENS");
  assert.deepEqual(result.evidence.tokens.sort(), ["Relojes", "Xoff"]);
});

check("SUPPLIER_TOKENS — insensível a caixa", () => {
  assert.equal(checkSupplierTokens({ descriptionHtml: "<p>clearance item</p>" })?.code, "SUPPLIER_TOKENS");
});

check("SUPPLIER_TOKENS — não dispara em descrição limpa", () => {
  assert.equal(checkSupplierTokens({ descriptionHtml: "<p>Official Pokémon collectible.</p>" }), null);
});

// ── SUPPLIER_TOKENS estendido a descrições de coleção — B14 (24/09/2026), secção 3 ──
// Caso real: as 21+2 coleções live com o placeholder interno de universeCollections.server.js
// / autoCollections.server.js — ver collectionDescriptionPlaceholder.js.

check("SUPPLIER_TOKENS — dispara com o placeholder de coleção Universe", () => {
  const result = checkSupplierTokens({
    descriptionHtml: "<p>Coleção Universe — produtos com alterpop.franchise = Batman. Rascunho: confirmar e publicar no Admin.</p>",
  });
  assert.equal(result?.code, "SUPPLIER_TOKENS");
  assert.deepEqual(result.evidence.tokens, ["Coleção Universe — produtos com"]);
});

check("SUPPLIER_TOKENS — dispara com o placeholder de coleção automática", () => {
  const result = checkSupplierTokens({
    descriptionHtml: "<p>Coleção criada automaticamente — produtos com licença Batman.</p>",
  });
  assert.equal(result?.code, "SUPPLIER_TOKENS");
  assert.deepEqual(result.evidence.tokens, ["Coleção criada automaticamente —"]);
});

// ── FRANCHISE_UNKNOWN — briefing 27/09 (N2): categorias/marcas misturadas com franquias ──

check("FRANCHISE_UNKNOWN — dispara com \"Anime\" (categoria, não universo)", () => {
  const r = checkFranchiseUnknown({ resolvedFranchise: "Anime" });
  assert.equal(r?.code, "FRANCHISE_UNKNOWN");
  assert.deepEqual(r.evidence.values, ["Anime"]);
});

check("FRANCHISE_UNKNOWN — dispara com \"Funko\" (marca, não universo)", () => {
  assert.equal(checkFranchiseUnknown({ resolvedFranchise: "Funko" })?.code, "FRANCHISE_UNKNOWN");
});

check("FRANCHISE_UNKNOWN — não dispara com \"The Legend of Zelda\" (status closed continua resolvido)", () => {
  assert.equal(checkFranchiseUnknown({ resolvedFranchise: "The Legend of Zelda" }), null);
});

check("FRANCHISE_UNKNOWN — não dispara com um universo dormente (Wonder Woman)", () => {
  assert.equal(checkFranchiseUnknown({ resolvedFranchise: "Wonder Woman" }), null);
});

check("FRANCHISE_UNKNOWN — dispara com \"Pokémon\" de acento decomposto (NFD ≠ canónico NFC)", () => {
  const nfd = "Pokémon".normalize("NFD");
  assert.notEqual(nfd, "Pokémon".normalize("NFC"));
  assert.equal(checkFranchiseUnknown({ resolvedFranchise: nfd })?.code, "FRANCHISE_UNKNOWN");
});

check("FRANCHISE_UNKNOWN — não dispara com \"Pokémon\" canónico (NFC)", () => {
  assert.equal(checkFranchiseUnknown({ resolvedFranchise: "Pokémon".normalize("NFC") }), null);
});

check("FRANCHISE_UNKNOWN — sem valor não dispara (isso é MISSING_FRANCHISE)", () => {
  assert.equal(checkFranchiseUnknown({ resolvedFranchise: null }), null);
  assert.equal(checkFranchiseUnknown({ resolvedFranchise: "" }), null);
});

check("findUnknownFranchiseValues — lista do metafield: só devolve os valores fora da tabela", () => {
  assert.deepEqual(findUnknownFranchiseValues(["Star Wars", "Funko", "Anime"]), ["Funko", "Anime"]);
  assert.deepEqual(findUnknownFranchiseValues(["One Piece"]), []);
});

check("findUnknownFranchiseValues — sem igualdade aproximada: caixa diferente conta como desconhecido", () => {
  assert.deepEqual(findUnknownFranchiseValues("star wars"), ["star wars"]);
});

// ── PRICE_RULE — implementada, mas FORA de PRE_PUBLISH_CHECKS até o B10 existir ──

check("PRICE_RULE — dispara para preço fora da regra do B10 (caso real: 20.76)", () => {
  const result = checkPriceRule({ retailPrice: 20.76 });
  assert.equal(result?.code, "PRICE_RULE");
});

check("PRICE_RULE — não dispara para preço já na regra (abaixo de 50 -> ,99; a partir de 50 -> inteiro)", () => {
  assert.equal(checkPriceRule({ retailPrice: 19.99 }), null);
  assert.equal(checkPriceRule({ retailPrice: 50 }), null);
  assert.equal(checkPriceRule({ retailPrice: 98 }), null);
});

check("PRICE_RULE — desligada: não está em PRE_PUBLISH_CHECKS enquanto o B10 não existir", () => {
  assert.equal(PRE_PUBLISH_CHECKS.includes(checkPriceRule), false);
});

// ── runPrePublishChecks — agrega, nunca bloqueia ──

check("runPrePublishChecks — agrega vários avisos, nunca lança", () => {
  const payload = {
    sku: "X",
    title: "Rides Star Wars Luke Skywalker in T-47 Airspeeder Exclusive",
    resolvedFranchise: null,
    resolvedFormat: null,
    descriptionHtml: "<p>Xoff</p>",
  };
  const warnings = runPrePublishChecks(payload, {});
  const codes = warnings.map((w) => w.code).sort();
  assert.deepEqual(codes, ["MISSING_FORMAT", "MISSING_FRANCHISE", "PREFIX_RESIDUE", "SUPPLIER_TOKENS"]);
});

check("runPrePublishChecks — FRANCHISE_UNKNOWN chega pelo agregador (caso real: \"Funko\")", () => {
  const payload = {
    sku: "X",
    title: "Star Wars Luke Skywalker",
    resolvedFranchise: "Funko",
    resolvedFormat: "Figure",
    descriptionHtml: "<p>Official collectible.</p>",
  };
  assert.deepEqual(runPrePublishChecks(payload, {}).map((w) => w.code), ["FRANCHISE_UNKNOWN"]);
});

check("runPrePublishChecks — payload limpo não dispara nada", () => {
  const payload = {
    sku: "X",
    title: "Star Wars Luke Skywalker",
    resolvedFranchise: "Star Wars",
    resolvedFormat: "Figure",
    descriptionHtml: "<p>Official Star Wars collectible.</p>",
  };
  assert.deepEqual(runPrePublishChecks(payload, {}), []);
});

check("cada verificação ativa tem de estar em PRE_PUBLISH_CHECKS (teste falha se alguém a remover)", () => {
  assert.equal(PRE_PUBLISH_CHECKS.includes(checkTitleDuplicate), true);
  assert.equal(PRE_PUBLISH_CHECKS.includes(checkPrefixResidue), true);
  assert.equal(PRE_PUBLISH_CHECKS.includes(checkMissingFranchise), true);
  assert.equal(PRE_PUBLISH_CHECKS.includes(checkFranchiseUnknown), true);
  assert.equal(PRE_PUBLISH_CHECKS.includes(checkMissingFormat), true);
  assert.equal(PRE_PUBLISH_CHECKS.includes(checkSupplierTokens), true);
  assert.equal(PRE_PUBLISH_CHECKS.includes(checkVendorUnmapped), true);
  assert.equal(PRE_PUBLISH_CHECKS.length, 7);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\npre-publish-checks: todos os casos passaram");
