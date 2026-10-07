#!/usr/bin/env node
/**
 * Briefing "Preço com margem e teto de mercado" (07/10/2026) — pricing.server.js.
 * Tabelas de teste do briefing + fronteiras + entradas inválidas + paridade
 * painel/publisher.
 * Uso: node scripts/tests/pricing.test.js
 */
import assert from "node:assert/strict";
import {
  roundUp,
  roundDown,
  finalPrice,
  priceProduct,
  tryPriceProduct,
  resolveMarginPct,
  DEFAULT_MARGIN_PCT,
  PricingError,
} from "../../lib/importer/pricing/pricing.server.js";
import { buildPublishPayload } from "../../lib/importer/shopify/shopifyMapper.server.js";

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
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

console.log("finalPrice — tabela do briefing (margem 40 %)");
for (const [dist, pvpr, price, status] of [
  [999, 1795, 1750, "MARGEM"],
  [499, 995, 850, "MARGEM"],
  [999, 1695, 1690, "TETO"],
  [5799, 9495, 9490, "TETO"],
  [12499, 22995, 21190, "MARGEM"],
  [999, 1295, 1350, "ACIMA_PVPR"],
  [999, null, 1750, "SEM_PVPR"],
]) {
  check(`${dist / 100} / PVPR ${pvpr == null ? "vazio" : pvpr / 100} → ${price / 100} ${status}`, () => {
    const r = finalPrice(dist, pvpr, 40);
    assert.equal(r.price, price);
    assert.equal(r.status, status);
  });
}
check("custo 9,99 × 1,21 = 12,09 (carrinho)", () => assert.equal(finalPrice(999, 1795, 40).cost, 1209));

console.log("roundDown — tabela do briefing");
for (const [inp, out] of [
  [1795, 1790],
  [1760, 1750],
  [1720, 1690],
  [10020, 9990],
  [22995, 22990],
]) {
  check(`${inp / 100} → ${out / 100}`, () => assert.equal(roundDown(inp), out));
}

console.log("roundUp — tabela do briefing anterior (a roundPrice de antes)");
for (const [inp, out] of [
  [1850, 1850],
  [1851, 1890],
  [1890, 1890],
  [1891, 1950],
  [9995, 10090],
  [10020, 10090],
  [14993, 15090],
]) {
  check(`${inp / 100} → ${out / 100}`, () => assert.equal(roundUp(inp), out));
}

console.log("Arredondamentos — varrimento 0,01 a 300 €");
const validEnd = (p) => (p < 10000 ? p % 100 === 50 || p % 100 === 90 : p % 100 === 90);
check("roundUp nunca desce, final sempre válido", () => {
  for (let c = 1; c <= 30000; c += 1) {
    const p = roundUp(c);
    assert.ok(p >= c && validEnd(p), `${c} → ${p}`);
  }
});
check("roundDown nunca sobe, final sempre válido, e é o maior possível", () => {
  for (let c = 50; c <= 30000; c += 1) {
    const p = roundDown(c);
    assert.ok(p <= c && validEnd(p), `${c} → ${p}`);
    assert.ok(roundUp(p + 1) > c, `${c} → ${p}: havia um final válido entre os dois`);
  }
});

console.log("Regra — preço nunca acima do PVPR, nunca abaixo do custo + 10 %");
check("varrimento de custos e PVPR", () => {
  for (let dist = 100; dist <= 20000; dist += 37) {
    for (const ratio of [1.1, 1.3, 1.5, 1.8, 2.2]) {
      const pvpr = Math.round(dist * ratio);
      const { price, cost, status } = finalPrice(dist, pvpr, 40);
      assert.ok(price >= Math.ceil(cost * 1.1), `${dist}/${pvpr}: ${price} abaixo do piso`);
      if (status !== "ACIMA_PVPR") assert.ok(price <= pvpr, `${dist}/${pvpr}: ${price} acima do PVPR`);
      else assert.ok(price > pvpr, `${dist}/${pvpr}: ACIMA_PVPR mas ${price} ≤ PVPR`);
    }
  }
});

console.log("Entradas inválidas");
check("margem 4 % lança", () => assert.throws(() => finalPrice(1000, 2000, 4), PricingError));
check("margem 101 % lança", () => assert.throws(() => finalPrice(1000, 2000, 101), PricingError));
check("produto sem precio_distribuidores lança", () => {
  assert.throws(() => priceProduct(null, 17.95, 40), /Sem precio_distribuidores/);
  assert.throws(() => priceProduct(0, 17.95, 40), /Sem precio_distribuidores/);
});
check("tryPriceProduct devolve o erro em vez de lançar", () => {
  const r = tryPriceProduct(undefined, 17.95, 40);
  assert.equal(r.finalPrice, null);
  assert.equal(r.pvpr, 17.95);
  assert.match(r.priceError, /Sem precio_distribuidores/);
});
check("cêntimos não inteiros lançam", () => assert.throws(() => roundUp(18.5), PricingError));

console.log("priceProduct (euros do catálogo) — tabela do briefing, lucro em euros");
for (const [dist, pvpr, price, profit] of [
  [4.99, 9.95, 8.5, 2.46],
  [9.99, 17.95, 17.5, 5.41],
  [9.99, 16.95, 16.9, 4.81],
  [17.99, 29.95, 29.9, 8.13],
  [57.99, 94.95, 94.9, 24.73],
  [124.99, 229.95, 211.9, 60.66],
]) {
  check(`${dist} / ${pvpr} → ${price}, lucro ${profit}`, () => {
    const r = priceProduct(dist, pvpr, 40);
    assert.equal(r.finalPrice, price);
    assert.equal(r.profit, profit);
  });
}

console.log("resolveMarginPct");
check("sem valor gravado → 40", () => assert.equal(resolveMarginPct({}), DEFAULT_MARGIN_PCT));
check("valor gravado como string → número", () => assert.equal(resolveMarginPct({ priceMarginPct: "35" }), 35));
check("valor gravado fora do intervalo lança", () => assert.throws(() => resolveMarginPct({ priceMarginPct: 150 }), PricingError));

console.log("Painel e publisher — mesmo valor para o mesmo SKU");
for (const [distributorPrice, grossPrice] of [
  [9.99, 17.95],
  [9.99, 16.95],
  [124.99, 229.95],
  [9.99, 12.95],
  [9.99, null],
]) {
  await checkAsync(`${distributorPrice} / ${grossPrice}`, async () => {
    const row = { sku: "T-1", title: "Test", titleSource: "supplier", distributorPrice, grossPrice };
    const payload = await buildPublishPayload(row, { marginPct: 40 });
    const panel = tryPriceProduct(distributorPrice, grossPrice, 40);
    assert.equal(payload.retailPrice, panel.finalPrice);
    assert.equal(payload.priceStatus, panel.priceStatus);
    assert.equal(payload.priceError, null);
  });
}
await checkAsync("publisher sem precio_distribuidores: retailPrice null, erro explícito", async () => {
  const payload = await buildPublishPayload(
    { sku: "T-2", title: "Test", titleSource: "supplier", distributorPrice: null, grossPrice: 17.95 },
    { marginPct: 40 }
  );
  assert.equal(payload.retailPrice, null);
  assert.match(payload.priceError, /Sem precio_distribuidores/);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
