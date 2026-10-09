#!/usr/bin/env node
/**
 * «Aprovar Toda a Pesquisa (13 016)» aprovava 10 000 em silêncio (limite da primeira página).
 * collectAllPages percorre todas as páginas e falha se não somarem o total.
 * Uso: node scripts/tests/collect-pages.test.js
 */
import assert from "node:assert/strict";
import { collectAllPages } from "../../lib/curation/collectPages.js";

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FALHA  ${name}\n    ${err.message}`);
  }
}

/** Base falsa: N SKUs, páginas de `size`, como queryProductsPaginated. */
const fakeDb = (n, size = 10000) => async (page) => {
  const all = Array.from({ length: n }, (_, i) => `SKU-${String(i).padStart(6, "0")}`);
  return { skus: all.slice((page - 1) * size, page * size), totalCount: n };
};

await check("13 016 produtos: lê as duas páginas e devolve todos (não 10 000)", async () => {
  const r = await collectAllPages(fakeDb(13016));
  assert.equal(r.skus.length, 13016);
  assert.equal(r.totalCount, 13016);
  assert.equal(new Set(r.skus).size, 13016);
});
await check("exatamente 10 000 e 10 001: sem página perdida nem repetida", async () => {
  assert.equal((await collectAllPages(fakeDb(10000))).skus.length, 10000);
  assert.equal((await collectAllPages(fakeDb(10001))).skus.length, 10001);
  assert.equal((await collectAllPages(fakeDb(20000))).skus.length, 20000);
});
await check("poucos produtos e zero produtos", async () => {
  assert.equal((await collectAllPages(fakeDb(4))).skus.length, 4);
  const r = await collectAllPages(fakeDb(0));
  assert.deepEqual(r.skus, []);
});
await check("a página lê-se uma vez por 10 000, não uma por produto", async () => {
  let calls = 0;
  const db = fakeDb(13016);
  await collectAllPages(async (p) => {
    calls += 1;
    return db(p);
  });
  assert.equal(calls, 2);
});
await check("páginas que não somam o total (catálogo a mudar) → lança, nunca devolve um subconjunto", async () => {
  // A base diz 13 016 mas a página 2 vem vazia.
  const db = fakeDb(13016);
  await assert.rejects(
    () => collectAllPages(async (p) => (p === 1 ? db(1) : { skus: [], totalCount: 13016 })),
    /Contagem inconsistente: a pesquisa tem 13016 produtos mas só foi possível ler 10000/
  );
});
await check("SKUs repetidos entre páginas (ordenação instável) são apanhados pelo total", async () => {
  await assert.rejects(
    () => collectAllPages(async (p) => ({ skus: ["A", "B"], totalCount: 4 })),
    /Contagem inconsistente/
  );
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
