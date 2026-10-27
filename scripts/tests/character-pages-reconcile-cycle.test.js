#!/usr/bin/env node
/**
 * B7, passo 9 (briefing backend, 17/09/2026) — characterPagesReconcileCycle.server.js,
 * decideCharacterCycleAction (parte pura, sem Shopify/Prisma/fs). Mesmo travão do
 * live-drift-reconcile-cycle.test.js, aplicado a Characters em vez de metafields.
 * Uso: node scripts/tests/character-pages-reconcile-cycle.test.js
 */
import assert from "node:assert/strict";
import { liveCountsFromLinks } from "../../lib/importer/shopify/characterPagesSync.server.js";
import {
  decideCharacterCycleAction,
  MAX_CHARACTER_CHANGES_PER_CYCLE,
  characterCycleEnabled,
} from "../../lib/importer/shopify/characterPagesReconcileCycle.server.js";

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

function action(handle, act, extra = {}) {
  return { handle, action: act, universo: "One Piece", count: 5, ...extra };
}

check("PR 4b: contagens vêm de ProductCharacter; SKU sem franquia não conta; handles múltiplos contam", () => {
  const active = [{ id: "P1", sku: "S1" }, { id: "P2", sku: "S2" }, { id: "P3", sku: "S3" }];
  const handles = new Map([["S1", ["luke-skywalker", "grogu"]], ["S2", ["gandalf"]], ["S3", ["legolas"]]]);
  const franchise = new Map([["S1", "Star Wars"], ["S2", "The Lord of the Rings"]]);
  const live = liveCountsFromLinks(active, handles, franchise);
  assert.deepEqual(live.get("luke-skywalker"), { universo: "Star Wars", productSkus: ["S1"], productIds: ["P1"] });
  assert.deepEqual(live.get("grogu"), { universo: "Star Wars", productSkus: ["S1"], productIds: ["P1"] });
  assert.deepEqual(live.get("gandalf"), { universo: "The Lord of the Rings", productSkus: ["S2"], productIds: ["P2"] });
  assert.equal(live.has("legolas"), false);
});

check("ciclo de personagens desligado por defeito (só CHARACTER_CYCLE_ENABLED=true liga)", () => {
  assert.equal(characterCycleEnabled({}), false);
  assert.equal(characterCycleEnabled({ CHARACTER_CYCLE_ENABLED: "false" }), false);
  assert.equal(characterCycleEnabled({ CHARACTER_CYCLE_ENABLED: "true" }), true);
});

check(`MAX_CHARACTER_CHANGES_PER_CYCLE é ${MAX_CHARACTER_CHANGES_PER_CYCLE}`, () => {
  assert.equal(MAX_CHARACTER_CHANGES_PER_CYCLE, 10);
});

check("só skips → green, nada a aplicar", () => {
  const decision = decideCharacterCycleAction([action("elsa", "skip"), action("luigi", "skip")]);
  assert.equal(decision.status, "green");
  assert.deepEqual(decision.toApply, []);
  assert.deepEqual(decision.blocked, []);
});

check("sem ações nenhumas → green", () => {
  const decision = decideCharacterCycleAction([]);
  assert.equal(decision.status, "green");
});

check("1 create → yellow, entra em toApply", () => {
  const decision = decideCharacterCycleAction([action("luffy", "create")]);
  assert.equal(decision.status, "yellow");
  assert.equal(decision.toApply.length, 1);
  assert.equal(decision.toApply[0].handle, "luffy");
});

check("create + reactivate + update + set-draft contam todos para o travão", () => {
  const decision = decideCharacterCycleAction([
    action("a", "create"),
    action("b", "reactivate"),
    action("c", "update"),
    action("d", "set-draft"),
  ]);
  assert.equal(decision.status, "yellow");
  assert.equal(decision.toApply.length, 4);
});

check(`exatamente ${MAX_CHARACTER_CHANGES_PER_CYCLE} mudanças → ainda yellow (travão é ACIMA)`, () => {
  const actions = Array.from({ length: MAX_CHARACTER_CHANGES_PER_CYCLE }, (_, i) => action(`h${i}`, "create"));
  const decision = decideCharacterCycleAction(actions);
  assert.equal(decision.status, "yellow");
  assert.equal(decision.toApply.length, MAX_CHARACTER_CHANGES_PER_CYCLE);
  assert.deepEqual(decision.blocked, []);
});

check(`${MAX_CHARACTER_CHANGES_PER_CYCLE + 1} mudanças → travão dispara, red, nada em toApply`, () => {
  const actions = Array.from({ length: MAX_CHARACTER_CHANGES_PER_CYCLE + 1 }, (_, i) => action(`h${i}`, "create"));
  const decision = decideCharacterCycleAction(actions);
  assert.equal(decision.status, "red");
  assert.deepEqual(decision.toApply, []);
  assert.equal(decision.blocked.length, MAX_CHARACTER_CHANGES_PER_CYCLE + 1);
});

check("error (>128 produtos) nunca entra no travão nem é aplicado, mas é sempre reportado", () => {
  const decision = decideCharacterCycleAction([action("luffy", "create"), action("batman", "error", { error: "muitos produtos" })]);
  assert.equal(decision.status, "yellow");
  assert.equal(decision.toApply.length, 1);
  assert.equal(decision.errors.length, 1);
  assert.equal(decision.errors[0].handle, "batman");
});

check("só error, sem mudanças reais → green (nada para o travão decidir), mas erro reportado", () => {
  const decision = decideCharacterCycleAction([action("batman", "error", { error: "muitos produtos" })]);
  assert.equal(decision.status, "green");
  assert.equal(decision.errors.length, 1);
});

check("11 mudanças + 1 error → red, error continua fora do travão e reportado à parte", () => {
  const actions = Array.from({ length: MAX_CHARACTER_CHANGES_PER_CYCLE + 1 }, (_, i) => action(`h${i}`, "create"));
  actions.push(action("batman", "error", { error: "muitos produtos" }));
  const decision = decideCharacterCycleAction(actions);
  assert.equal(decision.status, "red");
  assert.equal(decision.blocked.length, MAX_CHARACTER_CHANGES_PER_CYCLE + 1);
  assert.equal(decision.errors.length, 1);
});

console.log(`\n${failures === 0 ? "OK" : "FALHOU"} — ${failures} falha(s)\n`);
process.exit(failures === 0 ? 0 : 1);
