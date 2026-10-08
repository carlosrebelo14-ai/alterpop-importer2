#!/usr/bin/env node
/**
 * Briefing "Preço com margem e teto de mercado" (07/10/2026) + revisão do dry-run
 * (piso de 80 % do PVPR, estado PISO_PVPR) — pricing.server.js.
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
  effectiveMarginPct,
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
  // Revisão do dry-run — piso de 80 % do PVPR (custo anormalmente baixo face ao PVPR).
  [1299, 4195, 3390, "PISO_PVPR"], // One Piece Film Red: custo 15,72, PVPR 41,95
  [999, 2995, 2450, "PISO_PVPR"], // Star Wars Armorer: custo 12,09, PVPR 29,95
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

console.log("Regra — nunca acima do PVPR, nunca abaixo de 80 % do PVPR nem do custo + 10 %");
check("varrimento de custos, PVPR e margens", () => {
  for (const margin of [5, 10, 25, 40, 60, 100]) {
    for (let dist = 100; dist <= 20000; dist += 37) {
      for (const ratio of [1.05, 1.1, 1.3, 1.5, 1.8, 2.2, 2.6, 3.5]) {
        const pvpr = Math.round(dist * ratio);
        const at = `${dist}/${pvpr}/${margin}%`;
        const { price, cost, status } = finalPrice(dist, pvpr, margin);
        assert.ok(validEnd(price), `${at}: ${price} com final inválido`);
        assert.ok(price >= Math.ceil(cost * 1.1), `${at}: ${price} abaixo do custo + 10 %`);
        if (status === "ACIMA_PVPR") {
          assert.ok(price > pvpr, `${at}: ACIMA_PVPR mas ${price} ≤ PVPR`);
          continue;
        }
        assert.ok(price <= pvpr, `${at}: ${price} acima do PVPR`);
        // Piso de 80 %: só pode ficar abaixo quando o teto (PVPR arredondado para baixo) o impede.
        assert.ok(price >= Math.min(Math.ceil(pvpr * 0.8), roundDown(pvpr)), `${at}: ${price} abaixo de 80 % do PVPR`);
        if (status === "PISO_PVPR") {
          assert.ok(price > roundUp(Math.ceil((cost * (100 + margin)) / 100)), `${at}: PISO_PVPR sem subir a margem`);
        }
      }
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

console.log("Revisão adversarial do PR #87");
check("margem decimal não sobe um degrau por vírgula flutuante (31,25 × 1,328 = 41,50)", () => {
  assert.equal(priceProduct(25.83, null, 32.8).finalPrice, 41.5);
  assert.equal(priceProduct(51.65, 100, 28.8).finalPrice, 80.5);
  assert.equal(priceProduct(247.93, null, 33.3).finalPrice, 399.9);
});
check("margem decimal: preço nunca abaixo da conta exata em inteiros", () => {
  for (let dist = 100; dist <= 30000; dist += 17) {
    for (const m of [12.5, 28.8, 32.8, 33.3, 48.8, 64.8]) {
      const cost = Math.round((dist * 121) / 100);
      const bps = Math.round(m * 100);
      const exact = Math.ceil((cost * (10000 + bps)) / 10000); // inteiro / inteiro
      const { price } = finalPrice(dist, null, m);
      assert.equal(price, roundUp(exact), `${dist}/${m}%`);
    }
  }
});
check("margem com mais de 2 casas decimais é recusada, não arredondada", () => {
  assert.throws(() => finalPrice(1116, null, 40.001), PricingError);
  assert.equal(finalPrice(1116, null, 40.01).price, 1950);
});
check("margem 5–9 % aplica 10 % e o estado segue a margem efetiva", () => {
  for (const m of [5, 7, 9]) {
    assert.deepEqual(finalPrice(999, 1500, m), finalPrice(999, 1500, 10));
  }
  assert.equal(effectiveMarginPct(5), 10);
  assert.equal(effectiveMarginPct(40), 40);
});
check("piso do PVPR acima da margem efetiva é PISO_PVPR, nunca MARGEM", () => {
  for (const m of [5, 8, 10, 25, 40]) {
    for (let dist = 100; dist <= 20000; dist += 41) {
      const pvpr = Math.round(dist * 2.6);
      const r = finalPrice(dist, pvpr, m);
      const target = roundUp(Math.ceil((r.cost * (10000 + Math.max(m, 10) * 100)) / 10000));
      if (r.status === "MARGEM") assert.equal(r.price, target, `${dist}/${pvpr}/${m}%: MARGEM mas preço ≠ margem efetiva`);
    }
  }
});

console.log("priceProduct (euros do catálogo) — tabela do briefing, lucro em euros");
for (const [dist, pvpr, price, profit] of [
  [4.99, 9.95, 8.5, 2.46],
  [9.99, 17.95, 17.5, 5.41],
  [9.99, 16.95, 16.9, 4.81],
  [17.99, 29.95, 29.9, 8.13],
  [57.99, 94.95, 94.9, 24.73],
  [124.99, 229.95, 211.9, 60.66],
  [12.99, 41.95, 33.9, 18.18],
  [9.99, 29.95, 24.5, 12.41],
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
  [12.99, 41.95],
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
