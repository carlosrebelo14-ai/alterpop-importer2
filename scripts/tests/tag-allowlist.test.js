#!/usr/bin/env node
/**
 * N4, opção A (29/09/2026) — lista permitida de tags.
 * Casos reais do mapa de 29/09: "Onepiece" (ref) vs "One Piece" (token), "Xoff" (XOFF
 * limpo só em categoryMain, não em franchises), "Offers" (glossário OFERTAS), marcas
 * (vendor) e categorias (productType) nas tags.
 * Uso: node scripts/tests/tag-allowlist.test.js
 */
import assert from "node:assert/strict";
import {
  ALLOWED_PRODUCT_TAGS,
  isAllowedTag,
  findTagsOutsideAllowlist,
  planTagsCleanup,
  probeTagBuilder,
} from "../../lib/importer/shopify/tagAllowlist.js";
import {
  buildShopifyProductTags,
  buildProductDescriptionHtml,
  ALTERPOP_APP_TAGS,
} from "../../lib/importer/shopify/shopifyMapper.server.js";

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

// ── builder ──

check("lista permitida = [\"alterpop\"], a mesma marca que o shopifyReset usa", () => {
  assert.deepEqual([...ALLOWED_PRODUCT_TAGS], ["alterpop"]);
  assert.deepEqual([...ALTERPOP_APP_TAGS], [...ALLOWED_PRODUCT_TAGS]);
});

check("buildShopifyProductTags — vendor, refs, tokens, XOFF, OFERTAS e customTags não viram tags", () => {
  const tags = buildShopifyProductTags(
    "FUNKO",
    ["ONEPIECE", "ONE PIECE", "ANIME / MANGA", "XOFF", "OFERTAS"],
    ["tag-manual"],
    { title: "One Piece Luffy", categoryMain: "ANIME / MANGA" },
  );
  assert.deepEqual(tags, ["alterpop"]);
});

check("buildShopifyProductTags — produto sem sinais continua com a marca da app", () => {
  assert.deepEqual(buildShopifyProductTags(null, [], [], {}), ["alterpop"]);
});

check("sonda — o builder real passa", () => {
  const p = probeTagBuilder(buildShopifyProductTags);
  assert.equal(p.ok, true, `gerou ${p.produced.join(", ")}`);
});

check("sonda — um builder que ainda gere tags do feed é apanhado (é o que faz o tags-cleanup recusar)", () => {
  const oldBuilder = (vendor, franchises) => ["alterpop", vendor, ...franchises];
  const p = probeTagBuilder(oldBuilder);
  assert.equal(p.ok, false);
  assert.ok(p.outside.includes("FUNKO"));
  assert.ok(p.outside.includes("XOFF"));
});

// ── descrição: sem fallback filter.p.tag ──

check("descrição — universo sem coleção fica sem link e sem filter.p.tag (caso real: Wonder Woman, dormente)", () => {
  const html = buildProductDescriptionHtml({ sku: "X", title: "Wonder Woman Figure", resolvedFranchise: "Wonder Woman" });
  assert.equal(html.includes("filter.p.tag"), false);
  assert.ok(html.includes("Wonder Woman"));
  assert.equal(/<a [^>]*>Wonder Woman<\/a>/.test(html), false);
});

check("descrição — universo com coleção mantém o link direto", () => {
  const html = buildProductDescriptionHtml({ sku: "X", title: "Luffy Figure", resolvedFranchise: "One Piece" });
  assert.ok(html.includes('href="/collections/one-piece"'));
});

// ── portão TAG_OUTSIDE_ALLOWLIST ──

check("portão — \"alterpop\" é permitida, sem distinção de maiúsculas", () => {
  assert.equal(isAllowedTag("alterpop"), true);
  assert.equal(isAllowedTag(" Alterpop "), true);
  assert.equal(isAllowedTag("Onepiece"), false);
});

check("portão — vermelho com a lista de produtos e as tags fora da lista (caso real Onepiece/One Piece)", () => {
  const r = findTagsOutsideAllowlist([
    { handle: "a", sku: "1", tags: ["alterpop", "Onepiece", "Funko"] },
    { handle: "b", sku: "2", tags: ["alterpop", "One Piece", "Onepiece"] },
    { handle: "c", sku: "3", tags: ["alterpop"] },
  ]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.offenders.map((o) => o.handle), ["a", "b"]);
  assert.deepEqual(r.offenders[0].tags, ["Onepiece", "Funko"]);
  assert.deepEqual(r.distinctTags[0], { tag: "Onepiece", count: 2 });
});

check("portão — verde só com tags permitidas", () => {
  assert.equal(findTagsOutsideAllowlist([{ handle: "a", tags: ["alterpop"] }, { handle: "b", tags: [] }]).ok, true);
});

// ── plano do tags-cleanup ──

const P = (over) => ({ productId: "gid://shopify/Product/1", handle: "h", sku: "S", tags: ["alterpop", "Xoff", "Offers"], syncLocked: false, ...over });

check("limpeza — remove só as tags fora da lista, nunca \"alterpop\"", () => {
  const plan = planTagsCleanup([P()]);
  assert.deepEqual(plan.removals[0].tags, ["Xoff", "Offers"]);
  assert.equal(plan.tagsToRemove, 2);
});

check("limpeza — sync_locked fica marcado e de fora sem OK", () => {
  const plan = planTagsCleanup([P({ syncLocked: true })]);
  assert.equal(plan.removals.length, 0);
  assert.equal(plan.lockedSkipped.length, 1);
});

check("limpeza — sync_locked entra com includeLocked (OK explícito)", () => {
  const plan = planTagsCleanup([P({ syncLocked: true })], { includeLocked: true });
  assert.equal(plan.removals.length, 1);
  assert.equal(plan.lockedSkipped.length, 0);
});

check("limpeza — produto limpo não entra; processed = total", () => {
  const plan = planTagsCleanup([P(), P({ productId: "2", tags: ["alterpop"] }), P({ productId: "3", syncLocked: true })]);
  assert.equal(plan.clean, 1);
  assert.equal(plan.processed, 3);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\ntag-allowlist: todos os casos passaram");
