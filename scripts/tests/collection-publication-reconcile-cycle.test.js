#!/usr/bin/env node
/**
 * B14 (briefing backend, 24/09/2026), secções 7 e 8 — V14,
 * collectionPublicationReconcileCycle.server.js, decideV14CycleAction (parte pura, sem
 * Shopify/fs).
 * Uso: node scripts/tests/collection-publication-reconcile-cycle.test.js
 */
import assert from "node:assert/strict";
import {
  decideV14CycleAction,
} from "../../lib/importer/shopify/collectionPublicationReconcileCycle.server.js";
import { MAX_AUTO_PUBLISH } from "../../lib/importer/shopify/collectionPublication.server.js";

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

// ── verde ──

check("verde — sem nada por publicar e nenhuma closed publicada", () => {
  const decision = decideV14CycleAction({ preconditionsOk: true, published: [], registerOnly: [], errors: [] });
  assert.equal(decision.status, "green");
  assert.equal(decision.reason, null);
});

// ── amarelo ──

check("amarelo — publicou coleções no ciclo", () => {
  const decision = decideV14CycleAction({
    preconditionsOk: true,
    published: [{ handle: "batman", title: "Batman" }],
    registerOnly: [],
    errors: [],
  });
  assert.equal(decision.status, "yellow");
});

check("amarelo — encontrou uma closed já publicada (nunca despublica, só regista)", () => {
  const decision = decideV14CycleAction({
    preconditionsOk: true,
    published: [],
    registerOnly: [{ handle: "zelda", title: "The Legend of Zelda" }],
    errors: [],
  });
  assert.equal(decision.status, "yellow");
});

// ── vermelho: travão ──

check(`vermelho — travão dispara com mais de MAX_AUTO_PUBLISH (${MAX_AUTO_PUBLISH}) por publicar`, () => {
  const decision = decideV14CycleAction({
    preconditionsOk: true,
    brakeTriggered: true,
    overLimitCount: MAX_AUTO_PUBLISH + 1,
  });
  assert.equal(decision.status, "red");
  assert.match(decision.reason, /travão/);
  assert.match(decision.reason, new RegExp(String(MAX_AUTO_PUBLISH + 1)));
});

check(`vermelho — NÃO dispara com exatamente MAX_AUTO_PUBLISH (${MAX_AUTO_PUBLISH}) por publicar`, () => {
  const decision = decideV14CycleAction({
    preconditionsOk: true,
    brakeTriggered: false,
    published: Array.from({ length: MAX_AUTO_PUBLISH }, (_, i) => ({ handle: `h${i}` })),
    registerOnly: [],
    errors: [],
  });
  assert.equal(decision.status, "yellow");
});

// ── vermelho: userErrors ──

check("vermelho — userErrors ao publicar", () => {
  const decision = decideV14CycleAction({
    preconditionsOk: true,
    published: [],
    registerOnly: [],
    errors: [{ handle: "batman", errors: [{ field: ["publicationId"], message: "Publication is not valid for this shop" }] }],
  });
  assert.equal(decision.status, "red");
  assert.match(decision.reason, /userErrors/);
});

// ── vermelho: publicationId inválido / scopes em falta ──

check("vermelho — publicationId inválido (checkCyclePreconditions falhou)", () => {
  const decision = decideV14CycleAction({
    preconditionsOk: false,
    preconditionsReason: 'publicationId "gid://shopify/Publication/999" não encontrado em publications(first: 50)',
  });
  assert.equal(decision.status, "red");
  assert.match(decision.reason, /publicationId/);
});

check("vermelho — write_publications em falta (checkCyclePreconditions falhou)", () => {
  const decision = decideV14CycleAction({
    preconditionsOk: false,
    preconditionsReason: "scope(s) em falta: write_publications",
  });
  assert.equal(decision.status, "red");
  assert.match(decision.reason, /write_publications/);
});

// ── precedência entre estados ──

check("travão vence sobre published/registerOnly (nunca reporta amarelo quando o travão disparou)", () => {
  const decision = decideV14CycleAction({
    preconditionsOk: true,
    brakeTriggered: true,
    overLimitCount: MAX_AUTO_PUBLISH + 3,
    published: [{ handle: "x" }],
    registerOnly: [{ handle: "y" }],
  });
  assert.equal(decision.status, "red");
});

check("preconditionsOk:false vence sobre tudo o resto", () => {
  const decision = decideV14CycleAction({
    preconditionsOk: false,
    preconditionsReason: "scope(s) em falta: write_publications",
    brakeTriggered: true,
    published: [{ handle: "x" }],
  });
  assert.equal(decision.status, "red");
  assert.match(decision.reason, /write_publications/);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\ncollection-publication-reconcile-cycle: todos os casos passaram");
