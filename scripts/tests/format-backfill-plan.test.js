#!/usr/bin/env node
/**
 * C3 (briefing 29/09/2026) — formatBackfillPlan.js (plano do format-backfill.js).
 * Uso: node scripts/tests/format-backfill-plan.test.js
 */
import assert from "node:assert/strict";
import { planFormatBackfill, formatMetafieldInput } from "../../lib/importer/catalog/formatBackfillPlan.js";

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

let seq = 0;
const R = (over) => {
  seq += 1;
  return {
    productId: `gid://shopify/Product/${seq}`,
    handle: `h${seq}`,
    sku: `S${seq}`,
    liveFormat: "Figure",
    computed: "Vinyl Figure",
    prismaFormat: "Vinyl Figure",
    hasCatalogRow: true,
    syncLocked: false,
    ...over,
  };
};

check("Figure → Vinyl Figure entra no plano", () => {
  const p = planFormatBackfill([R()]);
  assert.equal(p.sets.length, 1);
  assert.equal(p.blocked, false);
});

check("idempotente — já com o valor novo não entra", () => {
  assert.equal(planFormatBackfill([R({ liveFormat: "Vinyl Figure" })]).alreadyOk.length, 1);
});

check("guarda — valor calculado fora do vocabulário bloqueia tudo", () => {
  const p = planFormatBackfill([R(), R({ computed: "Figure", prismaFormat: "Figure" })]);
  assert.equal(p.outsideVocabulary.length, 1);
  assert.equal(p.blocked, true);
});

check("guarda — Prisma ainda no vocabulário antigo bloqueia tudo (indexador não correu)", () => {
  const p = planFormatBackfill([R(), R({ prismaFormat: "Figure" })]);
  assert.equal(p.prismaStale.length, 1);
  assert.equal(p.blocked, true);
});

check("vazio — sem valor live fica na lista dos vazios", () => {
  const p = planFormatBackfill([R({ liveFormat: null, computed: null, prismaFormat: null })]);
  assert.equal(p.staysEmpty.length, 1);
  assert.equal(p.sets.length, 0);
});

check("vazio — com valor live antigo vai para liveToClear, nunca é escrito (metafieldsDelete fora da regra)", () => {
  const p = planFormatBackfill([R({ liveFormat: "Figure", computed: null, prismaFormat: null })]);
  assert.equal(p.liveToClear.length, 1);
  assert.equal(p.sets.length, 0);
});

check("sync_locked de fora sem includeLocked; entra com includeLocked", () => {
  assert.equal(planFormatBackfill([R({ syncLocked: true })]).lockedSkipped.length, 1);
  assert.equal(planFormatBackfill([R({ syncLocked: true })], { includeLocked: true }).sets.length, 1);
});

check("contagens antes e depois por valor", () => {
  const p = planFormatBackfill([R(), R(), R({ computed: "Prize Figure", prismaFormat: "Prize Figure" }), R({ liveFormat: null, computed: null, prismaFormat: null })]);
  assert.deepEqual(p.before, [["Figure", 3], ["(vazio)", 1]]);
  assert.deepEqual(Object.fromEntries(p.after), { "Vinyl Figure": 2, "Prize Figure": 1, "(vazio)": 1 });
});

check("processed = total, sem linha no catálogo incluída", () => {
  const p = planFormatBackfill([R(), R({ hasCatalogRow: false })]);
  assert.equal(p.noCatalogRow.length, 1);
  assert.equal(p.processed, 2);
});

check("metafield — list.single_line_text_field com o valor em lista", () => {
  assert.deepEqual(formatMetafieldInput("gid://shopify/Product/1", "Home & Gifts"), {
    ownerId: "gid://shopify/Product/1",
    namespace: "alterpop",
    key: "format",
    type: "list.single_line_text_field",
    value: '["Home & Gifts"]',
  });
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nformat-backfill-plan: todos os casos passaram");
