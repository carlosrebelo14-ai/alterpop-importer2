#!/usr/bin/env node
/**
 * Tarefa 58 (Decisão 30) — duas corridas consecutivas de franchise-reconcile.js
 * devolveram 8 e depois 2 linhas para os MESMOS 8 SKUs, sem exceção lançada — só
 * "NO_CATALOG_ROW" a mais na primeira corrida. Mesma classe de falha da Decisão
 * 28/Tarefa 51 (contenção SQLite), num script que não passava por safePrisma nem
 * tinha qualquer verificação.
 *
 * `loadCatalogRowsForReconcile` recebe um cliente prisma-like injetado — testa o
 * contrato sem tocar em SQLite real: erro de query lança, leitura inconsistente
 * (findMany/count a discordar sem exceção) lança, leitura consistente devolve as
 * linhas normalmente (incluindo o caso legítimo de SKUs sem linha — isso continua a
 * ser resultado válido, não uma inconsistência).
 *
 * Uso: node scripts/tests/franchise-reconcile-read-safety.test.js
 */
import assert from "node:assert/strict";
import { loadCatalogRowsForReconcile } from "../catalog/franchise-reconcile.js";

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

async function main() {
  await check("erro de query lançado propaga (aborta o relatório, não vira NO_CATALOG_ROW)", async () => {
    const fakePrisma = {
      catalogProduct: {
        findMany: async () => {
          throw new Error("SQLITE_BUSY: database is locked");
        },
        count: async () => 8,
      },
    };
    await assert.rejects(
      () => loadCatalogRowsForReconcile(fakePrisma, {}, {}),
      /FALHA DE LEITURA/
    );
  });

  await check(
    "findMany() e count() a discordar SEM exceção lançada — sintoma exato do incidente, tem de lançar",
    async () => {
      const fakePrisma = {
        catalogProduct: {
          findMany: async () => [{ sku: "a" }, { sku: "b" }], // 2 linhas
          count: async () => 8, // deveria ser 8 — leitura inconsistente
        },
      };
      await assert.rejects(
        () => loadCatalogRowsForReconcile(fakePrisma, {}, {}),
        /LEITURA INCONSISTENTE/
      );
    }
  );

  await check(
    "leitura consistente com SKUs genuinamente sem linha (findMany < skus pedidos, mas = count) NÃO lança — continua NO_CATALOG_ROW válido",
    async () => {
      const fakePrisma = {
        catalogProduct: {
          // só 2 dos hipotéticos 8 SKUs pedidos têm linha — legítimo, count concorda.
          findMany: async () => [{ sku: "a" }, { sku: "b" }],
          count: async () => 2,
        },
      };
      const rows = await loadCatalogRowsForReconcile(fakePrisma, {}, {});
      assert.equal(rows.length, 2);
    }
  );

  await check("leitura consistente e completa devolve todas as linhas normalmente", async () => {
    const fakePrisma = {
      catalogProduct: {
        findMany: async () => [{ sku: "a" }, { sku: "b" }, { sku: "c" }],
        count: async () => 3,
      },
    };
    const rows = await loadCatalogRowsForReconcile(fakePrisma, {}, {});
    assert.equal(rows.length, 3);
  });

  if (failures) {
    console.error(`\n${failures} falha(s)`);
    process.exit(1);
  }
  console.log("\nfranchise-reconcile-read-safety: todos os casos passaram");
}

main();
