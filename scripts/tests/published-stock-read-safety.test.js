#!/usr/bin/env node
/**
 * DBG-09 (relatório de 14/10/2026) · erro de leitura do catálogo no sync de stock dos publicados.
 *
 * Antes, `safePrisma(..., { fallback: [] })` convertia a falha de leitura em lista vazia. Com
 * `stockBySku` vazio, cada SKU saía como "sem alteração" e o ciclo reportava 0 falhas. Agora
 * `loadPublishedStockRows` lança (rethrow), como o publisher (Tarefa 51), e o chamador conta a
 * falha no registo de sync.
 *
 * Falha real, sem mocks: BD vazia, sem a tabela CatalogProduct. Não é corrupção, por isso o
 * safePrisma não grava o modo degradado nem mexe em ficheiros.
 *
 * Uso: node scripts/tests/published-stock-read-safety.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "published-stock-read-"));
process.env.DATABASE_URL = `file:${path.join(dir, "empty.sqlite")}`;

const { loadPublishedStockRows } = await import("../../lib/importer/shopify/publishedStockSync.server.js");
const { prisma, safePrisma } = await import("../../lib/prisma/prismaSafe.server.js");

// Guarda o console.error real: o main() silencia o log do safePrisma, mas a falha tem de sair.
const erroReal = console.error;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    erroReal(`FAIL  ${name}\n      ${err.message}`);
  }
}

async function main() {
  // Silencia o log de erro do safePrisma: o caminho é o esperado.
  const erroOriginal = console.error;
  console.error = () => {};
  try {
    await check("leitura que falha lança; não devolve lista vazia", async () => {
      await assert.rejects(
        () => loadPublishedStockRows("loja-de-teste.myshopify.com", ["SKU-1", "SKU-2"]),
        (err) => {
          assert.ok(err instanceof Error, "tem de lançar um Error");
          assert.ok(err.message.length > 0, "a mensagem do erro tem de chegar ao chamador");
          return true;
        }
      );
    });

    await check("contraprova: com fallback [] o mesmo erro vira lista vazia (o defeito)", async () => {
      const semRethrow = await safePrisma(
        "publishedStockSync.loadRows",
        () => prisma.catalogProduct.findMany({ where: { shop: "x", sku: { in: ["SKU-1"] } } }),
        { fallback: [] }
      );
      assert.deepEqual(semRethrow, [], "o fallback antigo escondia a falha — é isto que o rethrow evita");
    });
  } finally {
    console.error = erroReal;
  }

  await prisma.$disconnect().catch(() => {});

  if (failures) {
    erroReal(`\n${failures} falha(s)`);
    process.exit(1);
  }
  console.log("\npublished-stock-read-safety: todos os casos passaram");
  process.exit(0);
}

main();
