#!/usr/bin/env node
/**
 * 24/09 — `syncPublishedStockLevels` já calculava `failures[]` (sku + message) mas
 * `api.trigger-sync.jsx` só lia a contagem agregada; o array era descartado no fim do
 * request, sem log nem persistência — uma falha real (SKU publicado que saiu do feed)
 * ficava invisível para sempre. A correção ([app/routes/api.trigger-sync.jsx]) percorre
 * `stockResult.failures` e chama `persistSyncError` para cada uma, reaproveitando o
 * registo de sync que `SyncErrorLogsPanel` já lê em app.reports.jsx.
 *
 * Este teste prova o mecanismo de ponta a ponta (persistSyncError → listSyncErrors) com
 * uma falha simulada de stock, sem precisar de simular o pedido HTTP inteiro do
 * trigger-sync (que não tem cobertura própria, como o resto desse ficheiro).
 *
 * Uso: node scripts/tests/stock-sync-failure-log.test.js
 */
import assert from "node:assert/strict";
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { persistSyncError, listSyncErrors } from "../../lib/importer/sync/syncErrorLog.server.js";

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

function patchPrisma() {
  const rows = [];
  const originals = {
    create: prisma.syncErrorLog.create,
    findMany: prisma.syncErrorLog.findMany,
  };
  let nextId = 1;
  prisma.syncErrorLog.create = async ({ data }) => {
    const row = { id: String(nextId++), active: true, createdAt: new Date(), ...data };
    rows.push(row);
    return row;
  };
  prisma.syncErrorLog.findMany = async ({ where }) => {
    return rows
      .filter((r) => r.shop === where.shop)
      .sort((a, b) => b.createdAt - a.createdAt);
  };
  const restore = () => {
    prisma.syncErrorLog.create = originals.create;
    prisma.syncErrorLog.findMany = originals.findMany;
  };
  return { rows, restore };
}

async function main() {
  await check("falha de stock simulada — sku e mensagem sobrevivem a persistSyncError → listSyncErrors", async () => {
    const { restore } = patchPrisma();
    try {
      const shop = "test-shop-stock.myshopify.com";
      // Mesma forma que publishedStockSync.server.js produz em result.failures[].
      const simulatedFailure = { sku: "4573102723772", message: "Produto/variante não encontrado na Shopify" };

      // Exatamente o que api.trigger-sync.jsx agora chama para cada stockResult.failures[].
      await persistSyncError({ shop, sku: simulatedFailure.sku, reason: simulatedFailure.message });

      const errors = await listSyncErrors(shop);
      assert.equal(errors.length, 1, "a falha simulada tem de ficar persistida");
      assert.equal(errors[0].sku, simulatedFailure.sku, "o SKU da falha tem de sobreviver — era isto que faltava antes");
      assert.equal(errors[0].message, simulatedFailure.message);
    } finally {
      restore();
    }
  });

  await check("múltiplas falhas do mesmo ciclo ficam todas visíveis, não só a última", async () => {
    const { restore } = patchPrisma();
    try {
      const shop = "test-shop-stock-2.myshopify.com";
      const simulatedFailures = [
        { sku: "sku-a", message: "erro 1" },
        { sku: "sku-b", message: "erro 2" },
      ];
      for (const f of simulatedFailures) {
        await persistSyncError({ shop, sku: f.sku, reason: f.message });
      }
      const errors = await listSyncErrors(shop);
      assert.equal(errors.length, 2);
      assert.deepEqual(
        errors.map((e) => e.sku).sort(),
        ["sku-a", "sku-b"]
      );
    } finally {
      restore();
    }
  });

  if (failures) {
    console.error(`\n${failures} falha(s)`);
    process.exit(1);
  }
  console.log("\nstock-sync-failure-log: todos os casos passaram");
}

main();
