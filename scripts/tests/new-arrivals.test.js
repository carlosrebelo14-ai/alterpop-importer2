#!/usr/bin/env node
/**
 * N1 (briefing 27/09, V15 revisto) — newArrivals.server.js.
 * Parte pura (decideNewArrivalsCycle, computeIsNewArrival) + ciclo com cliente falso e
 * diretório temporário (estado V15 e snapshot).
 * Uso: node scripts/tests/new-arrivals.test.js
 */
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  NEW_ARRIVAL_DAYS,
  computeIsNewArrival,
  buildFirstPublicationMetafields,
  decideNewArrivalsCycle,
  reconcileNewArrivalsCycle,
  loadNewArrivalsCycleState,
} from "../../lib/importer/shopify/newArrivals.server.js";

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

const NOW = new Date("2026-10-16T09:00:00Z");
const daysAgo = (d) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000).toISOString();

let seq = 0;
function product(over = {}) {
  seq += 1;
  return {
    productId: `gid://shopify/Product/${seq}`,
    handle: `p-${seq}`,
    sku: `SKU${seq}`,
    publishedAt: daysAgo(1),
    firstPublishedAt: null,
    isNewArrival: null,
    ...over,
  };
}

// ── regra dos 30 dias ──

await check("NEW_ARRIVAL_DAYS é 30", () => assert.equal(NEW_ARRIVAL_DAYS, 30));

await check("publicado há 29 dias → true", () => {
  assert.equal(computeIsNewArrival(daysAgo(29), NOW), true);
});

await check("publicado há 31 dias → false", () => {
  assert.equal(computeIsNewArrival(daysAgo(31), NOW), false);
});

await check("ciclo — 31 dias com is_new_arrival=true expira (sai no ciclo seguinte sem passo manual)", () => {
  const p = product({ firstPublishedAt: daysAgo(31), isNewArrival: true });
  const d = decideNewArrivalsCycle([p], {}, NOW);
  assert.equal(d.status, "yellow");
  assert.deepEqual(d.expirations.map((e) => e.productId), [p.productId]);
  assert.deepEqual(d.writes, [{ ownerId: p.productId, namespace: "alterpop", key: "is_new_arrival", type: "boolean", value: "false" }]);
});

await check("ciclo — 29 dias com is_new_arrival=true fica, verde", () => {
  const d = decideNewArrivalsCycle([product({ firstPublishedAt: daysAgo(29), isNewArrival: true })], {}, NOW);
  assert.equal(d.status, "green");
  assert.equal(d.writes.length, 0);
});

// ── republicação ──

await check("republicação de produto antigo — first_published_at inalterado, não reentra", () => {
  // publishedAt da Shopify mudou ontem (republicado); a data de primeira publicação é de há 40 dias.
  const p = product({ publishedAt: daysAgo(1), firstPublishedAt: daysAgo(40), isNewArrival: false });
  const d = decideNewArrivalsCycle([p], { [p.productId]: daysAgo(40) }, NOW);
  assert.equal(d.status, "green");
  assert.equal(d.writes.some((w) => w.key === "first_published_at"), false);
  assert.equal(d.writes.length, 0);
  assert.equal(d.nextSnapshot[p.productId], daysAgo(40));
});

await check("primeira publicação (publisher) — first_published_at = agora e is_new_arrival = true", () => {
  const m = buildFirstPublicationMetafields("gid://shopify/Product/1", NOW);
  assert.deepEqual(
    m.map((x) => [x.key, x.type, x.value]),
    [["first_published_at", "date_time", NOW.toISOString()], ["is_new_arrival", "boolean", "true"]],
  );
});

// ── sem travão por volume ──

await check("21 expirações no mesmo ciclo — escreve as 21, amarelo (travão por volume saiu)", () => {
  const ps = Array.from({ length: 21 }, () => product({ firstPublishedAt: daysAgo(31), isNewArrival: true }));
  const d = decideNewArrivalsCycle(ps, {}, NOW);
  assert.equal(d.status, "yellow");
  assert.equal(d.expirations.length, 21);
  assert.equal(d.writes.length, 21);
});

await check("lote real 16/09 (44 One Piece + 13 Luke) expira junto a 16/10 — amarelo, não vermelho", () => {
  const ps = Array.from({ length: 57 }, () => product({ firstPublishedAt: "2026-09-16T08:00:00Z", isNewArrival: true }));
  const d = decideNewArrivalsCycle(ps, {}, NOW);
  assert.equal(d.status, "yellow");
  assert.equal(d.expirations.length, 57);
});

// ── vermelho: anomalias ──

await check("vermelho — produto true sem first_published_at, e não é escrito", () => {
  const p = product({ isNewArrival: true, firstPublishedAt: null });
  const d = decideNewArrivalsCycle([p], {}, NOW);
  assert.equal(d.status, "red");
  assert.equal(d.anomalies[0].code, "TRUE_WITHOUT_DATE");
  assert.equal(d.writes.length, 0);
});

await check("vermelho — first_published_at no futuro", () => {
  const p = product({ firstPublishedAt: "2026-12-01T00:00:00Z", isNewArrival: true });
  const d = decideNewArrivalsCycle([p], {}, NOW);
  assert.equal(d.status, "red");
  assert.equal(d.anomalies[0].code, "FUTURE_DATE");
});

await check("vermelho — first_published_at alterado desde a última leitura; snapshot guarda o valor antigo", () => {
  const p = product({ firstPublishedAt: daysAgo(2), isNewArrival: true });
  const d = decideNewArrivalsCycle([p], { [p.productId]: daysAgo(40) }, NOW);
  assert.equal(d.status, "red");
  assert.equal(d.anomalies[0].code, "DATE_CHANGED");
  assert.equal(d.nextSnapshot[p.productId], daysAgo(40));
  assert.equal(d.writes.length, 0);
});

await check("vermelho não bloqueia os outros produtos — expiração de outro produto escreve na mesma", () => {
  const bad = product({ isNewArrival: true, firstPublishedAt: null });
  const old = product({ firstPublishedAt: daysAgo(31), isNewArrival: true });
  const d = decideNewArrivalsCycle([bad, old], {}, NOW);
  assert.equal(d.status, "red");
  assert.deepEqual(d.writes.map((w) => w.ownerId), [old.productId]);
});

// ── preenchimento (rascunho ativado à mão, ou falha do publisher) ──

await check("ACTIVE e publicado sem first_published_at recebe o valor no ciclo seguinte (= publishedAt)", () => {
  const p = product({ publishedAt: daysAgo(3), firstPublishedAt: null, isNewArrival: null });
  const d = decideNewArrivalsCycle([p], {}, NOW);
  assert.equal(d.status, "yellow");
  assert.deepEqual(
    d.writes.map((w) => [w.key, w.value]),
    [["first_published_at", daysAgo(3)], ["is_new_arrival", "true"]],
  );
  assert.equal(d.nextSnapshot[p.productId], daysAgo(3));
});

await check("ACTIVE publicado há 45 dias sem data — preenche com is_new_arrival=false (não entra)", () => {
  const p = product({ publishedAt: daysAgo(45) });
  const d = decideNewArrivalsCycle([p], {}, NOW);
  assert.deepEqual(d.writes.map((w) => [w.key, w.value]), [["first_published_at", daysAgo(45)], ["is_new_arrival", "false"]]);
});

await check("ACTIVE não publicado no Online Store (publishedAt null) — fica de fora", () => {
  const d = decideNewArrivalsCycle([product({ publishedAt: null })], {}, NOW);
  assert.equal(d.status, "green");
  assert.equal(d.writes.length, 0);
});

await check("escrita parcial — data presente, flag em falta → completa a flag", () => {
  const p = product({ firstPublishedAt: daysAgo(5), isNewArrival: null });
  const d = decideNewArrivalsCycle([p], {}, NOW);
  assert.deepEqual(d.writes.map((w) => [w.key, w.value]), [["is_new_arrival", "true"]]);
});

await check("is_new_arrival=false dentro da janela — não reativa", () => {
  const d = decideNewArrivalsCycle([product({ firstPublishedAt: daysAgo(5), isNewArrival: false })], {}, NOW);
  assert.equal(d.writes.length, 0);
});

await check("processed = total — cada produto lido é avaliado", () => {
  const ps = [product(), product({ publishedAt: null }), product({ firstPublishedAt: daysAgo(2), isNewArrival: true })];
  assert.equal(decideNewArrivalsCycle(ps, {}, NOW).evaluated, ps.length);
});

// ── ciclo com cliente falso e estado em /tmp ──

function fakeShop({ definitions = true, products = [], metafieldsSetError = null, throwOnProducts = false } = {}) {
  const writes = [];
  return {
    writes,
    async graphql(query, variables) {
      if (/NewArrivalsDefinitions/.test(query)) {
        const node = definitions ? { nodes: [{ id: "gid://x" }] } : { nodes: [] };
        return { isNew: node, firstAt: node };
      }
      if (/NewArrivalsActive/.test(query)) {
        if (throwOnProducts) throw new Error("rede em baixo");
        return {
          products: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: products.map((p) => ({
              id: p.productId,
              handle: p.handle,
              status: "ACTIVE",
              createdAt: p.publishedAt,
              publishedAt: p.publishedAt,
              variants: { nodes: [{ sku: p.sku }] },
              firstPublishedAt: p.firstPublishedAt ? { value: p.firstPublishedAt } : null,
              isNewArrival: p.isNewArrival == null ? null : { value: String(p.isNewArrival) },
            })),
          },
        };
      }
      if (/metafieldsSet/.test(query)) {
        writes.push(...variables.metafields);
        if (metafieldsSetError) return { metafieldsSet: { metafields: [], userErrors: [{ message: metafieldsSetError }] } };
        return { metafieldsSet: { metafields: variables.metafields.map(() => ({ id: "m" })), userErrors: [] } };
      }
      throw new Error(`query inesperada: ${query.slice(0, 40)}`);
    },
  };
}

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "v15-"));
}

await check("ciclo — definição em falta: vermelho, nada escrito, estado gravado", async () => {
  const dir = await tmpDir();
  const client = fakeShop({ definitions: false, products: [product()] });
  const state = await reconcileNewArrivalsCycle(client, "shop", { now: NOW, dataDir: dir });
  assert.equal(state.status, "red");
  assert.match(state.reason, /definição em falta/);
  assert.equal(client.writes.length, 0);
  assert.equal((await loadNewArrivalsCycleState(dir)).status, "red");
});

await check("ciclo — erro de escrita fica vermelho (nunca em silêncio)", async () => {
  const dir = await tmpDir();
  const client = fakeShop({ products: [product({ firstPublishedAt: daysAgo(31), isNewArrival: true })], metafieldsSetError: "boom" });
  const state = await reconcileNewArrivalsCycle(client, "shop", { now: NOW, dataDir: dir });
  assert.equal(state.status, "red");
  assert.equal(state.errors.length, 1);
});

await check("ciclo — falha de leitura grava estado vermelho em vez de lançar", async () => {
  const dir = await tmpDir();
  const state = await reconcileNewArrivalsCycle(fakeShop({ throwOnProducts: true }), "shop", { now: NOW, dataDir: dir });
  assert.equal(state.status, "red");
  assert.match(state.reason, /rede em baixo/);
  assert.equal((await loadNewArrivalsCycleState(dir)).status, "red");
});

await check("ciclo — preenche num ciclo, verde no seguinte; data mudada à mão fica vermelha no terceiro", async () => {
  const dir = await tmpDir();
  const p = product({ publishedAt: daysAgo(3) });

  const s1 = await reconcileNewArrivalsCycle(fakeShop({ products: [p] }), "shop", { now: NOW, dataDir: dir });
  assert.equal(s1.status, "yellow");
  assert.equal(s1.fills.length, 1);

  const written = { ...p, firstPublishedAt: daysAgo(3), isNewArrival: true };
  const s2 = await reconcileNewArrivalsCycle(fakeShop({ products: [written] }), "shop", { now: NOW, dataDir: dir });
  assert.equal(s2.status, "green");
  assert.equal(s2.trueCount, 1);

  const tampered = { ...written, firstPublishedAt: daysAgo(1) };
  const s3 = await reconcileNewArrivalsCycle(fakeShop({ products: [tampered] }), "shop", { now: NOW, dataDir: dir });
  assert.equal(s3.status, "red");
  assert.equal(s3.anomalies[0].code, "DATE_CHANGED");
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nnew-arrivals: todos os casos passaram");
