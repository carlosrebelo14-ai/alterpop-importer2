#!/usr/bin/env node
/**
 * Decisão 31 — fila de decisão: Prontos a aprovar · Preço manual · Regra desatualizada ·
 * Erros de sincronização. Classificação pura + cálculo sobre fila, catálogo e preços live
 * injetados (sem rede, sem BD).
 * Uso: node scripts/tests/decision-queue.test.js
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  decisionGroup,
  hasManualPrice,
  rowWarnings,
  DECISION_GROUPS,
  DECISION_GROUP_LABELS,
  DECISION_GROUP_IDS,
} from "../../lib/curation/decisionQueue.js";

// O módulo do servidor importa o Prisma; a BD nunca é lida (tudo injetado), só não pode faltar o URL.
process.env.DATABASE_URL = `file:${path.join(os.tmpdir(), "decision-queue-unused.sqlite")}`;
process.env.CURATION_DATA_DIR = os.tmpdir();
const { computeDecisionGroups, clearDecisionGroupsCache } = await import("../../lib/curation/decisionQueue.server.js");

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.stack?.split("\n").slice(0, 3).join("\n      ") || err.message}`);
  }
}

console.log("classificação");
await check("quatro grupos, com os nomes do briefing", () => {
  assert.deepEqual([...DECISION_GROUP_IDS].sort(), ["manual_price", "ready", "stale_rule", "sync_error"]);
  assert.deepEqual(DECISION_GROUP_LABELS, {
    ready: "Prontos a aprovar",
    manual_price: "Preço manual",
    stale_rule: "Regra desatualizada",
    sync_error: "Erros de sincronização",
  });
});
await check("PENDING sem avisos → pronto a aprovar; sem entrada na fila conta como PENDING", () => {
  assert.equal(decisionGroup({ status: "PENDING", warnings: [] }), DECISION_GROUPS.READY);
  assert.equal(decisionGroup({ status: null, warnings: [] }), DECISION_GROUPS.READY);
});
await check("PENDING com avisos não está em nenhum grupo (continua aprovável pela lista)", () => {
  assert.equal(decisionGroup({ status: "PENDING", warnings: ["price_error"] }), null);
});
await check("preço manual ativo → grupo Preço manual (PENDING, APPROVED, PUBLISHED)", () => {
  for (const status of ["PENDING", "APPROVED", "PUBLISHED", null]) {
    assert.equal(decisionGroup({ status, manualPrice: true }), DECISION_GROUPS.MANUAL_PRICE, String(status));
  }
});
await check("PUBLISHED com o selo Regra (differs) → regra desatualizada; ok/missing/unread → nenhum", () => {
  assert.equal(decisionGroup({ status: "PUBLISHED", liveState: "differs" }), DECISION_GROUPS.STALE_RULE);
  for (const liveState of ["ok", "missing", "unread", "no_rule", null]) {
    assert.equal(decisionGroup({ status: "PUBLISHED", liveState }), null, String(liveState));
  }
});
await check("SYNC_ERROR → erros de sincronização, mesmo com preço manual", () => {
  assert.equal(decisionGroup({ status: "SYNC_ERROR" }), DECISION_GROUPS.SYNC_ERROR);
  assert.equal(decisionGroup({ status: "SYNC_ERROR", manualPrice: true }), DECISION_GROUPS.SYNC_ERROR);
});
await check("REJECTED e APPROVED sem preço manual não estão em nenhum grupo", () => {
  assert.equal(decisionGroup({ status: "REJECTED", manualPrice: true }), null);
  assert.equal(decisionGroup({ status: "APPROVED" }), null);
});
await check("hasManualPrice e rowWarnings", () => {
  assert.equal(hasManualPrice({ metadata: { overrides: { price: 12.5 } } }), true);
  assert.equal(hasManualPrice({ metadata: { overrides: { price: 0 } } }), false);
  assert.equal(hasManualPrice({ metadata: { overrides: { marginPct: 20 } } }), false);
  assert.equal(hasManualPrice(null), false);
  assert.deepEqual(rowWarnings({ priceError: "x", confidenceLevel: "low" }), ["price_error", "low_confidence"]);
  assert.deepEqual(rowWarnings({ priceError: null, confidenceLevel: "high" }), []);
});

console.log("computeDecisionGroups");
const good = { titleSource: "supplier", categoryMain: "Figures", dimensions: "10 × 10 × 10 cm", weightKg: 1, hsCode: "950300" };
const row = (sku, over = {}) => ({ sku, distributorPrice: 9.99, grossPrice: 17.95, ...good, ...over });
const qi = (sku, status, extra = {}) => ({ sku, title_en: sku, status, metadata: { ...extra } });
const catalogRows = [
  row("READY"), // sem entrada na fila
  row("READY-OOS", { stock: 0 }), // esgotado continua pronto a aprovar
  row("PEND"),
  row("LOWCONF", { titleSource: "pipeline", categoryMain: null, dimensions: null, weightKg: null, hsCode: null }),
  row("NOPRICE", { distributorPrice: null }),
  row("MANUAL"),
  row("PUB-STALE"),
  row("PUB-OK"),
  row("PUB-MANUAL"),
  row("SYNCERR"),
  row("REJ"),
  row("APP"),
];
const queueItems = [
  qi("PEND", "PENDING"),
  qi("MANUAL", "PENDING", { overrides: { price: 12.5 } }),
  qi("PUB-STALE", "PUBLISHED"),
  qi("PUB-OK", "PUBLISHED"),
  qi("PUB-MANUAL", "PUBLISHED", { overrides: { price: 13 } }),
  qi("SYNCERR", "SYNC_ERROR"),
  qi("REJ", "REJECTED"),
  qi("APP", "APPROVED"),
  qi("GONE-ERR", "SYNC_ERROR"), // saiu do catálogo
  qi("GONE-MAN", "PENDING", { overrides: { price: 9 } }),
  qi("GONE-PEND", "PENDING"),
];
const deps = (over = {}) => ({
  noCache: true,
  marginPct: 10,
  rule: "NET", // 9,99 € com 10 % → 11,00 €
  loadQueue: async () => ({ items: queueItems }),
  loadCatalogRows: async () => catalogRows,
  loadLive: async (skus) => ({
    bySku: new Map(skus.map((s) => [s, { price: s === "PUB-OK" ? 11 : 14.5 }])),
    error: null,
  }),
  ...over,
});

await check("agrupa cada produto no grupo certo", async () => {
  const r = await computeDecisionGroups("t.myshopify.com", deps());
  assert.deepEqual(r.groups.ready.sort(), ["PEND", "READY", "READY-OOS"]);
  assert.deepEqual(r.groups.manual_price.sort(), ["GONE-MAN", "MANUAL", "PUB-MANUAL"]);
  assert.deepEqual(r.groups.stale_rule, ["PUB-STALE"]);
  assert.deepEqual(r.groups.sync_error.sort(), ["GONE-ERR", "SYNCERR"]);
  assert.deepEqual(r.counts, { ready: 3, manual_price: 3, stale_rule: 1, sync_error: 2 });
  assert.equal(r.liveError, null);
});
await check("produtos com avisos, rejeitados, aprovados e publicados conformes ficam fora dos grupos", async () => {
  const r = await computeDecisionGroups("t.myshopify.com", deps());
  const all = new Set(Object.values(r.groups).flat());
  for (const sku of ["LOWCONF", "NOPRICE", "REJ", "APP", "PUB-OK", "GONE-PEND"]) assert.equal(all.has(sku), false, sku);
});
await check("o stock não conta para estar pronto a aprovar", async () => {
  const r = await computeDecisionGroups("t.myshopify.com", deps());
  assert.ok(r.groups.ready.includes("READY-OOS"));
});
await check("cada produto está no máximo num grupo", async () => {
  const r = await computeDecisionGroups("t.myshopify.com", deps());
  const all = Object.values(r.groups).flat();
  assert.equal(new Set(all).size, all.length);
});
await check("regra desatualizada segue a regra em vigor: com LEGACY o preço live de 14,50 está conforme", async () => {
  const r = await computeDecisionGroups("t.myshopify.com", deps({ rule: "LEGACY", marginPct: 10 }));
  // 9,99 / PVPR 17,95 / 10 % em LEGACY dá 14,50 (piso 80 % do PVPR): PUB-STALE conforme.
  assert.equal(r.groups.stale_rule.includes("PUB-STALE"), false);
  assert.equal(r.groups.stale_rule.includes("PUB-OK"), true, "agora é o 11,00 € que difere");
});
await check("falha de leitura da loja: o grupo fica vazio e liveError diz porquê", async () => {
  const r = await computeDecisionGroups("t.myshopify.com", deps({ loadLive: async (skus) => ({ bySku: new Map(), error: "Preço live não lido: timeout" }) }));
  assert.deepEqual(r.groups.stale_rule, []);
  assert.match(r.liveError, /timeout/);
  assert.ok(r.groups.manual_price.includes("PUB-MANUAL"), "o resto não depende da loja");
});
await check("cache curta por loja", async () => {
  clearDecisionGroupsCache();
  let calls = 0;
  const d = deps({ noCache: false, now: 1_000_000, loadQueue: async () => (calls++, { items: queueItems }) });
  await computeDecisionGroups("cache.myshopify.com", d);
  await computeDecisionGroups("cache.myshopify.com", { ...d, now: 1_005_000 });
  assert.equal(calls, 1);
  await computeDecisionGroups("cache.myshopify.com", { ...d, now: 1_030_000 });
  assert.equal(calls, 2);
  clearDecisionGroupsCache();
});

console.log("ligação ao painel");
const fs = await import("node:fs");
await check("api.products, export e 'Aprovar toda a pesquisa' passam a loja ao filtro (grupos da fila)", () => {
  const read = (f) => fs.readFileSync(f, "utf8");
  assert.match(read("app/routes/api.products.jsx"), /computeCurationSkuFilter\(curationStatus, reasonFilter, session\.shop\)/);
  assert.match(read("app/routes/api.products.export.jsx"), /computeCurationSkuFilter\(curationStatus, reasonFilter, session\.shop\)/);
  assert.match(read("lib/curation/resolveFilteredSkus.server.js"), /computeCurationSkuFilter\([^)]*shop\)/);
  assert.match(read("lib/curation/curationStatusFilter.server.js"), /DECISION_GROUP_PREFIX/);
});
await check("o filtro de estado do painel tem os quatro grupos", () => {
  const src = fs.readFileSync("app/components/CurationFiltersBar.jsx", "utf8");
  assert.match(src, /DECISION_GROUP_LABELS/);
  assert.match(src, /DECISION_GROUP_PREFIX/);
});

if (failures) {
  console.error(`\n${failures} teste(s) falharam.`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
