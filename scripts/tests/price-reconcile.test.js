#!/usr/bin/env node
/**
 * Revisão do dry-run de preços (07/10/2026) — classifyPriceReconcile
 * (lib/importer/pricing/priceReconcile.server.js), a decisão partilhada pelo dry-run e
 * pela aplicação. Casos do dry-run real (jyr17t-wr, 07/10/2026).
 * Uso: node scripts/tests/price-reconcile.test.js
 */
import assert from "node:assert/strict";
import { classifyPriceReconcile, toReconcileRow, reconcileRowsToCsv } from "../../lib/importer/pricing/priceReconcile.server.js";

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

// Pop Gandalf: neto 14,83 → live 20,76 (= 14,83 × 1,4); custo 9,99 → 17,50 a 40 %.
const gandalf = {
  item: { metadata: { costAtPublish: 14.83 } },
  prices: { distributorPrice: 9.99, grossPrice: 17.95 },
  netPrice: 14.83,
  live: { price: 20.76 },
  marginPct: 40,
};

check("preço live = × 1,4 do custo na publicação → muda", () => {
  const r = classifyPriceReconcile(gandalf);
  assert.equal(r.category, "muda");
  assert.equal(r.price.finalPrice, 17.5);
  assert.match(r.reason, /custo na publicação/);
});
check("sem costAtPublish, bate com × 1,4 do netPrice atual → muda", () => {
  const r = classifyPriceReconcile({ ...gandalf, item: { metadata: {} } });
  assert.equal(r.category, "muda");
  assert.match(r.reason, /custo atual/);
});
check("preço live editado à mão → manual, nunca reescrito", () => {
  const r = classifyPriceReconcile({ ...gandalf, live: { price: 19.99 } });
  assert.equal(r.category, "manual");
});
check("preço live = precio_bruto (fórmula do importer) já não conta como da app → manual", () => {
  const r = classifyPriceReconcile({ ...gandalf, live: { price: 17.95 } });
  assert.equal(r.category, "manual");
});
check("live já igual à regra → igual", () => {
  const r = classifyPriceReconcile({ ...gandalf, item: { metadata: { costAtPublish: 12.5 } }, live: { price: 17.5 } });
  assert.equal(r.category, "igual");
});
check("override da curadoria → override, mesmo que bata com × 1,4", () => {
  const r = classifyPriceReconcile({ ...gandalf, item: { metadata: { costAtPublish: 14.83, overrides: { price: 19 } } } });
  assert.equal(r.category, "override");
});
check("sync_locked → sync_locked", () => {
  const r = classifyPriceReconcile({ ...gandalf, live: { price: 20.76, syncLocked: true } });
  assert.equal(r.category, "sync_locked");
});
check("sem variante live → sem dados, com a causa do diagnóstico", () => {
  const r = classifyPriceReconcile({ ...gandalf, live: undefined, missingLiveReason: "produto X apagado na Shopify em 2026-09-17" });
  assert.equal(r.category, "sem dados");
  assert.match(r.reason, /apagado na Shopify/);
});
check("SKU duplicado no live → sem dados", () => {
  const r = classifyPriceReconcile({ ...gandalf, live: { price: 20.76, duplicate: true } });
  assert.equal(r.category, "sem dados");
});
check("fora do feed/catálogo → sem dados", () => {
  assert.equal(classifyPriceReconcile({ ...gandalf, prices: null }).category, "sem dados");
});
check("sem precio_distribuidores → sem dados com o erro do pricing", () => {
  const r = classifyPriceReconcile({ ...gandalf, prices: { distributorPrice: null, grossPrice: 17.95 } });
  assert.equal(r.category, "sem dados");
  assert.match(r.reason, /Sem precio_distribuidores/);
});
check("Film Red (custo baixo) → muda para o piso de 80 % do PVPR", () => {
  const r = classifyPriceReconcile({
    item: { metadata: {} },
    prices: { distributorPrice: 12.99, grossPrice: 41.95 },
    netPrice: 34.67,
    live: { price: 48.54 },
    marginPct: 40,
  });
  assert.equal(r.category, "muda");
  assert.equal(r.price.finalPrice, 33.9);
  assert.equal(r.price.priceStatus, "PISO_PVPR");
});

check("margem do produto na fila → preço da regra a essa margem (25 % → 15,50)", () => {
  const r = classifyPriceReconcile({ ...gandalf, item: { metadata: { costAtPublish: 14.83, overrides: { marginPct: 25 } } } });
  assert.equal(r.category, "muda");
  assert.equal(r.price.finalPrice, 15.5);
});
check("margem do produto inválida → sem dados, nunca a global", () => {
  const r = classifyPriceReconcile({ ...gandalf, item: { metadata: { costAtPublish: 14.83, overrides: { marginPct: 400 } } } });
  assert.equal(r.category, "sem dados");
  assert.match(r.reason, /Margem inválida/);
});

check("linha de relatório: delta e CSV", () => {
  const row = toReconcileRow({ sku: "889698135504", title: "POP Gandalf", live: gandalf.live, result: classifyPriceReconcile(gandalf) });
  assert.equal(row.delta, -3.26);
  assert.equal(row.after, 17.5);
  const csv = reconcileRowsToCsv([row]);
  assert.match(csv, /^sku,titulo,custo,pvpr,antes,depois,delta,lucro,estado_preco,regra_daria,categoria,motivo\n/);
  assert.match(csv, /889698135504,POP Gandalf,12\.09,17\.95,20\.76,17\.50,-3\.26,5\.41,MARGEM,17\.50,muda,/);
});
check("linha manual: sem 'depois' nem delta, mas com o que a regra daria", () => {
  const row = toReconcileRow({ sku: "x", title: "", live: { price: 19.99 }, result: classifyPriceReconcile({ ...gandalf, live: { price: 19.99 } }) });
  assert.equal(row.after, null);
  assert.equal(row.delta, null);
  assert.equal(row.ruleWouldBe, 17.5);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
