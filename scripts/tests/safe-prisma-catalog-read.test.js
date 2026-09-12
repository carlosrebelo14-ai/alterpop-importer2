#!/usr/bin/env node
/**
 * Tarefa 51 (Decisão 28) — regressão do incidente do lote piloto v4: uma falha de
 * leitura SQLite (contenção transitória) foi engolida por `safePrisma` sem
 * `fallback`, devolveu `undefined`/vazio, e 6 de 8 produtos reais falharam com "SKU
 * não encontrado no catálogo indexado" — indistinguível de ausência real de dados.
 *
 * Não mocka Prisma nem o Shopify client (sem framework de mocks no repo) — testa
 * diretamente o contrato de `safePrisma` que causou o bug, reproduzido no MESMO
 * shape que `loadCatalogRowsBySkus` (shopifyApprovedSync.server.js) usa hoje:
 * `{ rethrow: true }` propaga o erro (aborta o lote), o comportamento sem essa opção
 * é o que engolia o erro (documentado aqui para nunca mais reaparecer sem se notar).
 *
 * Uso: node scripts/tests/safe-prisma-catalog-read.test.js
 */
import assert from "node:assert/strict";
import { safePrisma } from "../../lib/prisma/prismaSafe.server.js";

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
  const boom = () => {
    throw new Error("SQLITE_BUSY: database is locked");
  };

  await check("rethrow:true propaga o erro — é assim que loadCatalogRowsBySkus aborta o lote hoje", async () => {
    await assert.rejects(
      () => safePrisma("simulacao.catalogProducts", boom, { rethrow: true }),
      /SQLITE_BUSY/
    );
  });

  await check(
    "SEM rethrow nem fallback (o bug original), o erro é engolido e vira undefined — nunca usar este shape para leitura de catálogo",
    async () => {
      const result = await safePrisma("simulacao.catalogProducts.semFallback", boom);
      assert.equal(result, undefined);
    }
  );

  await check(
    "0 linhas genuínas (sem erro) continuam a passar — findMany vazio não é um erro, não deve abortar o lote",
    async () => {
      const result = await safePrisma("simulacao.catalogProducts.vazio", async () => [], { rethrow: true });
      assert.deepEqual(result, []);
    }
  );

  if (failures) {
    console.error(`\n${failures} falha(s)`);
    process.exit(1);
  }
  console.log("\nsafe-prisma-catalog-read: todos os casos passaram");
}

main();
