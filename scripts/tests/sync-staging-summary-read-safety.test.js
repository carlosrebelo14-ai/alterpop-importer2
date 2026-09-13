#!/usr/bin/env node
/**
 * Briefing "Leitura confirmada" · Sítio A (Decisão 30) — `computeSyncStagingSummary`
 * decide o que o operador vê no resumo de pré-publicação. Antes: `safePrisma` com
 * `fallback: []` fazia uma falha de leitura parecer "todos os SKUs aprovados estão
 * em falta", mostrado ANTES de publicar — censado como BLOCKING em
 * docs/db-read-safety-census.md, mesmo sintoma do Incidente 1.
 *
 * Monkey-patcha prisma.catalogProduct.findMany/count no singleton importado
 * (sem framework de mocks no repo), restaura no fim de cada caso.
 *
 * Uso: node scripts/tests/sync-staging-summary-read-safety.test.js
 */
import assert from "node:assert/strict";
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { computeSyncStagingSummary } from "../../lib/importer/sync/syncStagingSummary.server.js";

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

function patchCatalogProduct({ rows, count }) {
  const original = {
    findMany: prisma.catalogProduct.findMany,
    count: prisma.catalogProduct.count,
  };
  prisma.catalogProduct.findMany = async () => {
    if (rows instanceof Error) throw rows;
    return rows;
  };
  prisma.catalogProduct.count = async () => count;
  return () => {
    prisma.catalogProduct.findMany = original.findMany;
    prisma.catalogProduct.count = original.count;
  };
}

async function main() {
  await check("caso 1 — erro de query simulado: resumo não é produzido, erro propaga", async () => {
    const restore = patchCatalogProduct({ rows: new Error("SQLITE_BUSY: database is locked"), count: 0 });
    try {
      await assert.rejects(() => computeSyncStagingSummary("test-shop", ["sku-1", "sku-2"]), /FALHA DE LEITURA/);
    } finally {
      restore();
    }
  });

  await check("caso 2 — findMany()/count() divergentes sem exceção: resumo não é produzido", async () => {
    const restore = patchCatalogProduct({ rows: [{ sku: "sku-1", netPrice: 10, title: "A" }], count: 999 });
    try {
      await assert.rejects(() => computeSyncStagingSummary("test-shop", ["sku-1", "sku-2"]), /LEITURA INCONSISTENTE/);
    } finally {
      restore();
    }
  });

  await check(
    "caso 3 — ausência legítima confirmada (SKU não indexado, count concorda): resumo mostra o SKU como missing, não lança",
    async () => {
      // pedidos sku-1 e sku-2; só sku-1 existe. count() com o mesmo where concorda (1).
      const restore = patchCatalogProduct({ rows: [{ sku: "sku-1", netPrice: 10, title: "A" }], count: 1 });
      try {
        const summary = await computeSyncStagingSummary("test-shop", ["sku-1", "sku-2"]);
        assert.equal(summary.foundCount, 1);
        assert.deepEqual(summary.missingSkus, ["sku-2"]);
      } finally {
        restore();
      }
    }
  );

  await check("caso 4 — leitura normal: resumo correto", async () => {
    const restore = patchCatalogProduct({
      rows: [
        { sku: "sku-1", netPrice: 10, title: "A" },
        { sku: "sku-2", netPrice: 20, title: "B" },
      ],
      count: 2,
    });
    try {
      const summary = await computeSyncStagingSummary("test-shop", ["sku-1", "sku-2"]);
      assert.equal(summary.foundCount, 2);
      assert.deepEqual(summary.missingSkus, []);
      assert.equal(summary.totalCostEur, 30);
    } finally {
      restore();
    }
  });

  if (failures) {
    console.error(`\n${failures} falha(s)`);
    process.exit(1);
  }
  console.log("\nsync-staging-summary-read-safety: todos os casos passaram");
}

main();
