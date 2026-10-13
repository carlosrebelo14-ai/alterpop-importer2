#!/usr/bin/env node
/* eslint-env node */
/**
 * Briefing "Preço sem IVA e guarda do tema" — regra NET (Decisão 31), pricing.server.js +
 * priceMode.js: tabela do briefing, arredondamento à dezena, flag PRICE_MODE desligada por
 * omissão (regra LEGACY intacta), regra explícita sem mudar a global.
 * Uso: node scripts/tests/price-net.test.js
 */
import assert from "node:assert/strict";
import {
  roundUpToTenCents,
  netPriceCents,
  finalPrice,
  priceProduct,
  tryPriceProduct,
  evaluatePrice,
  effectiveMarginPct,
  costCentsFromDistributor,
  PRICE_STATUS,
  PricingError,
} from "../../lib/importer/pricing/pricing.server.js";
import { currentPriceRule, isNetMode, resolvePriceRule, ruleOfRecord } from "../../lib/importer/pricing/priceMode.js";

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
function withMode(value, fn) {
  const prev = process.env.PRICE_MODE;
  if (value === undefined) delete process.env.PRICE_MODE;
  else process.env.PRICE_MODE = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PRICE_MODE;
    else process.env.PRICE_MODE = prev;
  }
}

console.log("roundUpToTenCents — dezena de cêntimos, todos os valores");
for (const [input, expected] of [
  [1432, 1440], // 14,32 → 14,40
  [1440, 1440], // 14,40 fica
  [10401, 10410], // 104,01 → 104,10
  [1, 10], // 0,01 → 0,10
  [0, 0],
  [9, 10],
  [10, 10],
  [1099, 1100],
]) {
  check(`${input / 100} € → ${expected / 100} €`, () => assert.equal(roundUpToTenCents(input), expected));
}
check("cêntimos inválidos lançam", () => {
  assert.throws(() => roundUpToTenCents(-1), PricingError);
  assert.throws(() => roundUpToTenCents(1.5), PricingError);
});

console.log("netPriceCents — fórmula do briefing");
check("9,99 € com margem 10 % dá 11,00 €", () => assert.equal(netPriceCents(999, 10), 1100));
check("passo a passo: raw 1098,9 cêntimos → ceil à dezena → 1100", () => {
  const raw = 999 * 1.1;
  assert.ok(Math.abs(raw - 1098.9) < 1e-6);
  assert.equal(Math.ceil(raw / 10) * 10, 1100);
});
check("exatamente na dezena fica (custo 10,00 € margem 10 % → 11,00 €)", () => assert.equal(netPriceCents(1000, 10), 1100));
check("margem decimal sem erro de vírgula flutuante (31,25 € a 32,8 % → 41,50 €)", () => {
  assert.equal(netPriceCents(3125, 32.8), 4150);
});
check("sem piso de 10 %: margem 5 % aplica 5 %", () => assert.equal(netPriceCents(1000, 5), 1050));
check("margem fora de 5–100 lança; mais de 2 casas lança", () => {
  assert.throws(() => netPriceCents(1000, 4), PricingError);
  assert.throws(() => netPriceCents(1000, 101), PricingError);
  assert.throws(() => netPriceCents(1000, 10.001), PricingError);
});
check("custo inválido lança", () => {
  assert.throws(() => netPriceCents(0, 10), PricingError);
  assert.throws(() => netPriceCents(10.5, 10), PricingError);
});
check("o resultado termina sempre em dezena de cêntimos", () => {
  for (let cost = 1; cost <= 3000; cost += 7) {
    for (const m of [5, 10, 25.5, 40, 99.99, 100]) {
      const p = netPriceCents(cost, m);
      assert.equal(p % 10, 0, `${cost} @ ${m} → ${p}`);
      assert.ok(p >= cost, `${cost} @ ${m} → ${p} abaixo do custo`);
      // nunca mais de uma dezena acima do valor exato (exato = cost × (1 + m %))
      assert.ok(p - (cost * (10000 + Math.round(m * 100))) / 10000 < 10, `${cost} @ ${m} → ${p} sobe demais`);
    }
  }
});

console.log("finalPrice/priceProduct em NET");
check("PVPR é só informativo: não limita nem sobe o preço", () => {
  assert.equal(finalPrice(999, 1295, 10, "NET").price, 1100); // PVPR 12,95 > 11,00
  assert.equal(finalPrice(999, 1000, 10, "NET").price, 1100); // PVPR 10,00 < preço: sem teto
  assert.equal(finalPrice(999, 100000, 10, "NET").price, 1100); // PVPR alto: sem piso de 80 %
  assert.equal(finalPrice(999, null, 10, "NET").price, 1100);
});
check("estado único MARGEM, custo sem IVA", () => {
  const r = finalPrice(999, 1000, 10, "NET");
  assert.equal(r.status, PRICE_STATUS.MARGEM);
  assert.equal(r.cost, 999);
});
check("PVPR inválido lança em NET como em LEGACY", () => assert.throws(() => finalPrice(999, 12.5, 10, "NET"), PricingError));
check("priceProduct: preço, custo, margem € e regra", () => {
  const r = priceProduct(9.99, 17.95, 10, "NET");
  assert.equal(r.finalPrice, 11);
  assert.equal(r.cost, 9.99);
  assert.equal(r.profit, 1.01); // margem € = preço final − custo bruto, com o arredondamento
  assert.equal(r.finalCents, 1100);
  assert.equal(r.costCents, 999);
  assert.equal(r.pvpr, 17.95);
  assert.equal(r.rule, "NET");
  assert.equal(r.priceStatus, "MARGEM");
});
check("tryPriceProduct devolve o erro em vez de lançar e traz a regra", () => {
  const r = tryPriceProduct(null, 17.95, 10, "NET");
  assert.equal(r.finalPrice, null);
  assert.match(r.priceError, /precio_distribuidores/);
  assert.equal(r.rule, "NET");
});
check("costCentsFromDistributor: NET sem IVA, LEGACY × 1,21", () => {
  assert.equal(costCentsFromDistributor(999, "NET"), 999);
  assert.equal(costCentsFromDistributor(999, "LEGACY"), 1209);
});
check("effectiveMarginPct: NET sem piso, LEGACY com piso de 10", () => {
  assert.equal(effectiveMarginPct(5, "NET"), 5);
  assert.equal(effectiveMarginPct(5, "LEGACY"), 10);
});

console.log("PRICE_MODE — desligada por omissão");
check("sem PRICE_MODE a regra é LEGACY", () =>
  withMode(undefined, () => {
    assert.equal(currentPriceRule(), "LEGACY");
    assert.equal(isNetMode(), false);
  }));
check("PRICE_MODE vazio ou LEGACY é LEGACY", () => {
  withMode("", () => assert.equal(currentPriceRule(), "LEGACY"));
  withMode("legacy", () => assert.equal(currentPriceRule(), "LEGACY"));
});
check("PRICE_MODE=NET (qualquer caixa, com espaços) liga NET", () => {
  withMode("NET", () => assert.equal(isNetMode(), true));
  withMode(" net ", () => assert.equal(isNetMode(), true));
});
check("PRICE_MODE com valor desconhecido lança (nunca cai em silêncio na regra errada)", () =>
  withMode("NETT", () => assert.throws(() => currentPriceRule(), /PRICE_MODE inválido/)));
check("flag desligada: o preço segue a regra atual (Gandalf 9,99 / PVPR 17,95 / 40 % → 17,50)", () =>
  withMode(undefined, () => {
    assert.equal(finalPrice(999, 1795, 40).price, 1750);
    assert.equal(priceProduct(9.99, 17.95, 40).finalPrice, 17.5);
    assert.equal(priceProduct(9.99, 17.95, 40).rule, "LEGACY");
  }));
check("flag ligada: os mesmos chamadores passam a NET", () =>
  withMode("NET", () => {
    assert.equal(finalPrice(999, 1795, 10).price, 1100);
    assert.equal(priceProduct(9.99, 17.95, 10).finalPrice, 11);
    assert.equal(tryPriceProduct(9.99, 17.95, 10).rule, "NET");
  }));
check("resolvePriceRule: explícita vence a global; desconhecida lança", () =>
  withMode(undefined, () => {
    assert.equal(resolvePriceRule("NET"), "NET");
    assert.equal(resolvePriceRule(undefined), "LEGACY");
    assert.throws(() => resolvePriceRule("ABC"), /Regra de preço inválida/);
  }));
check("ruleOfRecord: registos antigos sem campo são LEGACY", () => {
  assert.equal(ruleOfRecord(null), "LEGACY");
  assert.equal(ruleOfRecord({ price: 1 }), "LEGACY");
  assert.equal(ruleOfRecord({ rule: "NET" }), "NET");
});

console.log("evaluatePrice — ponto único");
check("regra explícita NET com a flag desligada não muda a global", () =>
  withMode(undefined, () => {
    const net = evaluatePrice(9.99, 17.95, 10, null, { rule: "NET" });
    assert.equal(net.finalPrice, 11);
    assert.equal(net.rule, "NET");
    assert.equal(isNetMode(), false);
    const legacy = evaluatePrice(9.99, 17.95, 40, null);
    assert.equal(legacy.finalPrice, 17.5);
    assert.equal(legacy.rule, "LEGACY");
  }));
check("margem do produto (overrides.marginPct) vale em NET", () => {
  const r = evaluatePrice(9.99, 17.95, 10, { metadata: { overrides: { marginPct: 20 } } }, { rule: "NET" });
  assert.equal(r.marginPct, 20);
  assert.equal(r.finalPrice, 12); // 9,99 × 1,2 = 11,988 → 12,00
});
check("margem do produto inválida: priceError e marginError, nunca a global", () => {
  const r = evaluatePrice(9.99, 17.95, 10, { metadata: { overrides: { marginPct: 150 } } }, { rule: "NET" });
  assert.equal(r.finalPrice, null);
  assert.ok(r.priceError && r.marginError);
});

if (failures) {
  console.error(`\n${failures} teste(s) falharam.`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
