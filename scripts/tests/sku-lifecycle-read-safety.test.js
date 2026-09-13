#!/usr/bin/env node
/**
 * Briefing "Leitura confirmada" · Sítio B (Decisão 30) — as duas leituras de
 * `runSkuLifecycleCycle` (skuLifecycle.server.js:64/:73) decidiam uma escrita de
 * estado persistente (CatalogSkuTracking). Antes: `safePrisma` com `fallback: []`
 * fazia uma falha de leitura virar "SKU não rastreado" e essa mentira era GRAVADA em
 * disco, sobrevivendo ao processo e ao ciclo seguinte — o mais grave dos dois sítios
 * censados como BLOCKING em docs/db-read-safety-census.md.
 *
 * Monkey-patcha os métodos Prisma usados por `runSkuLifecycleCycle` diretamente no
 * singleton `prisma` importado (sem framework de mocks no repo) e restaura no fim de
 * cada caso. Bateria de 4 casos, espelhando a Tarefa 58:
 *   1. erro de query simulado         → aborta, zero escritas
 *   2. findMany()/count() divergentes → aborta, zero escritas
 *   3. ausência legítima confirmada   → segue para escrita normal
 *   4. leitura normal                 → escrita correta
 *
 * Uso: node scripts/tests/sku-lifecycle-read-safety.test.js
 */
import assert from "node:assert/strict";
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { runSkuLifecycleCycle } from "../../lib/importer/catalog/skuLifecycle.server.js";

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

/**
 * Substitui os métodos Prisma usados pelo ciclo inteiro por stubs controlados.
 * `writesCalled` acumula o nome de qualquer método de escrita invocado — usado para
 * provar "zero escritas" (casos 1/2) ou "escreveu" (casos 3/4).
 */
function patchPrisma({ currentRows, currentCount, trackingRows, trackingCount }) {
  const writesCalled = [];
  const originals = {
    catalogProductFindMany: prisma.catalogProduct.findMany,
    catalogProductCount: prisma.catalogProduct.count,
    trackingFindMany: prisma.catalogSkuTracking.findMany,
    trackingCount: prisma.catalogSkuTracking.count,
    trackingCreateMany: prisma.catalogSkuTracking.createMany,
    executeRawUnsafe: prisma.$executeRawUnsafe,
    reportCreate: prisma.skuLifecycleCycleReport.create,
    reportFindMany: prisma.skuLifecycleCycleReport.findMany,
    trackingDeleteMany: prisma.catalogSkuTracking.deleteMany,
  };

  prisma.catalogProduct.findMany = async () => {
    if (currentRows instanceof Error) throw currentRows;
    return currentRows;
  };
  prisma.catalogProduct.count = async () => currentCount;
  prisma.catalogSkuTracking.findMany = async (args) => {
    // pruneOldLifecycleReports não usa este model; só o ciclo principal chama aqui.
    if (trackingRows instanceof Error) throw trackingRows;
    return trackingRows;
  };
  prisma.catalogSkuTracking.count = async () => trackingCount;
  prisma.catalogSkuTracking.createMany = async (...args) => {
    writesCalled.push("catalogSkuTracking.createMany");
    return { count: args?.[0]?.data?.length || 0 };
  };
  prisma.$executeRawUnsafe = async (...args) => {
    writesCalled.push("$executeRawUnsafe");
    return 0;
  };
  prisma.skuLifecycleCycleReport.create = async (...args) => {
    writesCalled.push("skuLifecycleCycleReport.create");
    return { id: "fake-report" };
  };
  prisma.skuLifecycleCycleReport.findMany = async () => []; // pruneOldLifecycleReports — sem nada a podar
  prisma.catalogSkuTracking.deleteMany = async () => {
    writesCalled.push("catalogSkuTracking.deleteMany");
    return { count: 0 };
  };

  const restore = () => {
    prisma.catalogProduct.findMany = originals.catalogProductFindMany;
    prisma.catalogProduct.count = originals.catalogProductCount;
    prisma.catalogSkuTracking.findMany = originals.trackingFindMany;
    prisma.catalogSkuTracking.count = originals.trackingCount;
    prisma.catalogSkuTracking.createMany = originals.trackingCreateMany;
    prisma.$executeRawUnsafe = originals.executeRawUnsafe;
    prisma.skuLifecycleCycleReport.create = originals.reportCreate;
    prisma.skuLifecycleCycleReport.findMany = originals.reportFindMany;
    prisma.catalogSkuTracking.deleteMany = originals.trackingDeleteMany;
  };

  return { writesCalled, restore };
}

async function main() {
  await check("caso 1 — erro de query simulado: aborta, zero escritas", async () => {
    const { writesCalled, restore } = patchPrisma({
      currentRows: new Error("SQLITE_BUSY: database is locked"),
      currentCount: 0,
      trackingRows: [],
      trackingCount: 0,
    });
    try {
      const result = await runSkuLifecycleCycle("test-shop-1");
      assert.equal(result, null, "runSkuLifecycleCycle mantém o contrato 'nunca lança mais acima' — devolve null");
      assert.deepEqual(writesCalled, [], "nenhuma escrita deve acontecer quando a leitura falha");
    } finally {
      restore();
    }
  });

  await check("caso 2 — findMany()/count() divergentes sem exceção: aborta, zero escritas", async () => {
    const { writesCalled, restore } = patchPrisma({
      currentRows: [{ sku: "a", vendor: "V", franchises: "[]" }],
      currentCount: 999, // discorda de propósito — sintoma do incidente
      trackingRows: [],
      trackingCount: 0,
    });
    try {
      const result = await runSkuLifecycleCycle("test-shop-2");
      assert.equal(result, null);
      assert.deepEqual(writesCalled, [], "leitura inconsistente também tem de abortar antes de qualquer escrita");
    } finally {
      restore();
    }
  });

  await check("caso 3 — ausência legítima confirmada (catálogo vazio, count concorda): segue para escrita normal", async () => {
    const { writesCalled, restore } = patchPrisma({
      currentRows: [], // nenhum produto — legítimo
      currentCount: 0, // count() concorda — não é inconsistência
      trackingRows: [{ sku: "old-sku", status: "active", missingCycles: 0 }],
      trackingCount: 1,
    });
    try {
      const result = await runSkuLifecycleCycle("test-shop-3");
      assert.notEqual(result, null, "leitura consistente (mesmo com catálogo vazio) tem de prosseguir para escrita");
      // old-sku desapareceu deste ciclo -> entra no chunk de "missing", que chama $executeRawUnsafe.
      assert.ok(writesCalled.includes("$executeRawUnsafe"), "SKU ausente confirmado devia acionar o UPDATE de missingCycles");
      assert.ok(writesCalled.includes("skuLifecycleCycleReport.create"), "ciclo bem sucedido grava sempre um relatório");
    } finally {
      restore();
    }
  });

  await check("caso 4 — leitura normal: escrita correta", async () => {
    // franchises como array (não a string JSON "[]" da coluna real) — evita um bug
    // pré-existente e não relacionado em isVip() (product.franchises.map assume
    // array, mas a coluna Prisma é String; fora do âmbito deste briefing, sinalizado
    // à parte). O teste só precisa de exercitar o caminho de escrita normal.
    const { writesCalled, restore } = patchPrisma({
      currentRows: [{ sku: "new-sku", vendor: "V", franchises: [] }],
      currentCount: 1,
      trackingRows: [],
      trackingCount: 0,
    });
    try {
      const result = await runSkuLifecycleCycle("test-shop-4");
      assert.notEqual(result, null);
      assert.ok(writesCalled.includes("catalogSkuTracking.createMany"), "SKU novo devia entrar via createMany");
      assert.ok(writesCalled.includes("skuLifecycleCycleReport.create"));
    } finally {
      restore();
    }
  });

  if (failures) {
    console.error(`\n${failures} falha(s)`);
    process.exit(1);
  }
  console.log("\nsku-lifecycle-read-safety: todos os casos passaram");
}

main();
