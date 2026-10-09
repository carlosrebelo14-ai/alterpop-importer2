#!/usr/bin/env node
/**
 * "Aplicar aos publicados", passo 3 — classificação em cinco categorias, um caso por
 * categoria + os casos de fronteira. Uso: node scripts/tests/published-reprice-classify.test.js
 */
import assert from "node:assert/strict";
import { classifyRepriceRow, summarizeReprice, activeLimit, REPRICE_CATEGORIES } from "../../lib/importer/pricing/publishedReprice.js";
import { buildLastPriceWrite } from "../../lib/importer/pricing/lastPriceWrite.js";

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

// Gandalf: custo 12,09, PVPR 17,95. Escrito a 14,90 com margem 20; a global é agora 10 → 14,50.
const catalog = { distributorPrice: 9.99, grossPrice: 17.95 };
const lastWrite = buildLastPriceWrite({ price: 14.9, cost: 12.09, pvpr: 17.95, marginPct: 20, priceStatus: "MARGEM", source: "backfill", marginInferred: true });
const item = (over = {}) => ({ sku: "G", title_en: "Gandalf", metadata: { shopifyProductId: "gid://shopify/Product/1", lastPriceWrite: lastWrite, ...over } });
const live = (price, over = {}) => ({ price, variantId: "gid://shopify/ProductVariant/1", productId: "gid://shopify/Product/1", ...over });
const classify = (over = {}) => classifyRepriceRow({ item: item(), catalog, live: live(14.9), globalPct: 10, ...over });

check("update — Gandalf: 14,90 → 14,50, −0,40 €, −2,7 %, motivo e limite", () => {
  const r = classify();
  assert.equal(r.category, "update");
  assert.equal(r.livePrice, 14.9);
  assert.equal(r.proposed, 14.5);
  assert.equal(r.diff, -0.4);
  assert.equal(r.diffPct, -2.68);
  assert.deepEqual(r.reasons, ["margem alterada (de 20 para 10)"]);
  assert.equal(r.limit, "PISO_PVPR");
  assert.equal(r.marginInferred, true);
});
check("conforme — preço da loja igual ao proposto", () => {
  const r = classify({ live: live(14.5) });
  assert.equal(r.category, "conforme");
});
check("ignored — preço manual: loja diferente da última escrita da app", () => {
  const r = classify({ live: live(15.5) });
  assert.equal(r.category, "ignored");
  assert.equal(r.reason, "preço manual preservado");
});
check("ignored — sem última escrita: nunca se assume que é da app", () => {
  const r = classify({ item: item({ lastPriceWrite: null }) });
  assert.equal(r.category, "ignored");
  assert.match(r.reason, /sem última escrita/);
});
check("ignored — produto trancado (sync_locked)", () => {
  const r = classify({ live: live(14.9, { syncLocked: true }) });
  assert.equal(r.category, "ignored");
  assert.match(r.reason, /sync_locked/);
});
check("notFound — sem variante live e product(id) provado inexistente", () => {
  const r = classify({ live: null, productExists: false });
  assert.equal(r.category, "notFound");
});
check("failed — sem variante live e existência por provar (nunca se assume apagado)", () => {
  const r = classify({ live: null, productExists: null, existsDetail: "timeout" });
  assert.equal(r.category, "failed");
  assert.match(r.reason, /não foi possível provar.*timeout/);
});
check("failed — produto existe mas sem variante com o SKU", () => {
  assert.equal(classify({ live: null, productExists: true }).category, "failed");
});
check("failed — SKU duplicado, fora do catálogo, sem custo, preço da loja inválido", () => {
  assert.equal(classify({ live: live(14.9, { duplicate: true }) }).category, "failed");
  assert.equal(classify({ catalog: null }).category, "failed");
  assert.equal(classify({ catalog: { distributorPrice: null, grossPrice: 17.95 } }).category, "failed");
  assert.equal(classify({ live: live(0) }).category, "failed");
});
check("margem do produto na fila entra no preço proposto", () => {
  const r = classify({ item: item({ overrides: { marginPct: 20 } }), live: live(14.9) });
  assert.equal(r.category, "conforme"); // 20 % dá 14,90
});
check("limite ativo: MARGEM, TETO, PISO_PVPR, piso de custo + 10 %", () => {
  assert.equal(activeLimit("MARGEM", 30), "MARGEM");
  assert.equal(activeLimit("TETO", 40), "TETO");
  assert.equal(activeLimit("PISO_PVPR", 10), "PISO_PVPR");
  assert.equal(activeLimit("ACIMA_PVPR", 10), "piso de custo + 10%");
  assert.equal(activeLimit("MARGEM", 5), "piso de custo + 10%");
});
check("totais: sobem, descem, soma da diferença e contagem por categoria somam o total", () => {
  const rows = [
    classify(), // −0,40
    classify({ live: live(14.5) }), // conforme
    classify({ live: live(15.5) }), // ignorado
    classify({ live: null, productExists: false }), // não encontrado
    classify({ live: null, productExists: null }), // falhado
    classify({ item: item({ lastPriceWrite: buildLastPriceWrite({ price: 12, source: "reprice" }) }), live: live(12) }), // sobe
  ];
  const s = summarizeReprice(rows);
  assert.equal(s.total, 6);
  assert.equal(REPRICE_CATEGORIES.reduce((n, c) => n + s.counts[c], 0), 6);
  assert.deepEqual(s.counts, { update: 2, conforme: 1, ignored: 1, notFound: 1, failed: 1 });
  assert.equal(s.ups, 1);
  assert.equal(s.downs, 1);
  assert.equal(s.sumDiff, 2.1); // −0,40 + 2,50
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
