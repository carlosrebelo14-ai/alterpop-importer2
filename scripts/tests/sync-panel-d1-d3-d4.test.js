#!/usr/bin/env node
/**
 * Briefing 06/11/2026, PR A. D1 (Ver Logs de Erro mostrava "200"), D3 (Sync Health com fonte própria)
 * e D4 (contadores do painel sem os estados todos). Helpers puros mais verificação de fonte nas rotas.
 * Uso: node scripts/tests/sync-panel-d1-d3-d4.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeSyncHealth } from "../../lib/importer/dashboard/syncHealth.js";
import { countQueueStates } from "../../lib/importer/dashboard/queueStateCounts.js";
import { describeRouteError } from "../../app/utils/routeErrorInfo.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

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

// D3
check("1 erro ativo em 10 publicados dá 90%", () => {
  const h = computeSyncHealth({ published: 10, activeErrors: 1 });
  assert.equal(h.rate, 0.9);
  assert.equal(h.label, "90%");
});
check("1289 erros ativos em 2446 publicados não dá 100%", () => {
  const h = computeSyncHealth({ published: 2446, activeErrors: 1289 });
  assert.ok(h.rate < 0.5 && h.rate > 0.4, String(h.rate));
});
check("sem publicados não há 100%: rate nulo e texto próprio", () => {
  const h = computeSyncHealth({ published: 0, activeErrors: 0 });
  assert.equal(h.rate, null);
  assert.equal(h.label, "sem produtos publicados");
});
check("erros acima dos publicados ficam limitados a 0%", () => {
  assert.equal(computeSyncHealth({ published: 5, activeErrors: 9 }).rate, 0);
});
check("banner, polling e Sync Health leem a mesma função de erros ativos", () => {
  const src = read("lib/importer/dashboard/getDashboardStats.server.js");
  const uses = src.match(/countActiveSyncErrorSkus\(shop\)/g) || [];
  assert.ok(uses.length >= 3, `só ${uses.length} usos`);
  assert.ok(src.includes("computeSyncHealth({ published: totalPublished, activeErrors: totalSyncError })"));
});

// D4
check("a soma dos estados fecha com o total da base", () => {
  const items = [
    ...Array.from({ length: 6 }, (_, i) => ({ sku: `p${i}`, status: "PENDING" })),
    { sku: "r1", status: "REJECTED" },
    ...Array.from({ length: 3 }, (_, i) => ({ sku: `u${i}`, status: "PUBLISHED" })),
    { sku: "e1", status: "SYNC_ERROR" },
    { sku: "a1", status: "APPROVED" },
    { sku: "fora", status: "PENDING" },
  ];
  const catalog = new Set(items.filter((i) => i.sku !== "fora").map((i) => i.sku));
  for (let i = 0; i < 4; i += 1) catalog.add(`sem-registo-${i}`);
  const c = countQueueStates(items, catalog, catalog.size);
  assert.equal(c.totalPending, 6);
  assert.equal(c.totalPublished, 3);
  assert.equal(c.totalQueueSyncError, 1);
  assert.equal(c.withoutRecord, 4);
  assert.equal(c.outsideCatalog, 1);
  assert.equal(c.stateSum, catalog.size);
});
check("os estados publicados e com erro aparecem na linha de filtro", () => {
  const src = read("app/routes/app._index.jsx");
  for (const f of ["totalPublished", "totalQueueSyncError", "withoutRecord", "stateSum"]) {
    assert.ok(src.includes(`dashboardStats?.${f}`), `falta ${f} na linha de filtro`);
  }
});

// D1
check("o botão Ver Logs de Erro navega pelo router, não por url", () => {
  const src = read("app/routes/app._index.jsx");
  assert.ok(!/content: "Ver Logs de Erro", url:/.test(src));
  assert.ok(src.includes('onAction: () => navigate("/app/reports")'));
});
check("bounce 200 mostra rota, estado e detalhe, nunca só o número", () => {
  const info = describeRouteError({ status: 200, statusText: "", data: "bounce" }, "/app/reports");
  assert.equal(info.status, 200);
  assert.equal(info.authBounce, true);
  assert.ok(info.route === "/app/reports" && info.detail.includes("bounce") && info.title.length > 10);
});
check("resposta 500 com data objeto serializa o data", () => {
  const info = describeRouteError({ status: 500, statusText: "Server Error", data: { a: 1 } }, "/app");
  assert.ok(info.detail.includes('{"a":1}') && info.title.includes("500"));
});
check("Error normal mostra a mensagem", () => {
  const info = describeRouteError(new Error("rebentou"), "/app");
  assert.equal(info.detail, "rebentou");
  assert.equal(info.status, null);
});
check("o ErrorBoundary de app.jsx usa o painel de rota", () => {
  assert.ok(read("app/routes/app.jsx").includes("return <RouteErrorPanel />"));
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nsync-panel-d1-d3-d4: todos os testes passaram");
