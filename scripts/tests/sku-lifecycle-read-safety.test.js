#!/usr/bin/env node
/**
 * Briefing "Leitura confirmada" · Sítio B (Decisão 30) — as duas leituras de
 * `runSkuLifecycleCycle` (skuLifecycle.server.js:64/:73) decidiam uma escrita de
 * estado persistente (CatalogSkuTracking). Antes: `safePrisma` com `fallback: []`
 * fazia uma falha de leitura virar "SKU não rastreado" e essa mentira era GRAVADA em
 * disco, sobrevivendo ao processo e ao ciclo seguinte — o mais grave dos dois sítios
 * censados como BLOCKING em docs/db-read-safety-census.md.
 *
 * Estendido 24/09 (incidente do trinco órfão + `skipDuplicates` em SQLite) com os
 * casos 5-7: modo semente, escrita incremental normal fora do modo semente, e a
 * garantia estática de que `skipDuplicates` nunca volta a aparecer no caminho de
 * escrita de CatalogSkuTracking (era isto que mantinha a tabela vazia há 43 dias,
 * engolido em silêncio pelo `safePrisma` com `rethrow:false` por omissão).
 *
 * Monkey-patcha os métodos Prisma usados por `runSkuLifecycleCycle` diretamente no
 * singleton `prisma` importado (sem framework de mocks no repo) e restaura no fim de
 * cada caso.
 *
 * Uso: node scripts/tests/sku-lifecycle-read-safety.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { runSkuLifecycleCycle, isLifecycleReportSuspect } from "../../lib/importer/catalog/skuLifecycle.server.js";
import { getDefaultConfig } from "../../lib/importer/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
 * provar "zero escritas" (casos 1/2) ou "escreveu" (casos 3+). `lastReportData`
 * captura o `data` passado a `skuLifecycleCycleReport.create` para inspecionar
 * `newSkuCount`/`newVipSkusJson` sem reabrir a base de dados.
 */
function patchPrisma({ currentRows, currentCount, trackingRows, trackingCount }) {
  const writesCalled = [];
  const state = { lastReportData: null };
  const originals = {
    catalogProductFindMany: prisma.catalogProduct.findMany,
    catalogProductCount: prisma.catalogProduct.count,
    trackingFindMany: prisma.catalogSkuTracking.findMany,
    trackingCount: prisma.catalogSkuTracking.count,
    trackingCreateMany: prisma.catalogSkuTracking.createMany,
    executeRawUnsafe: prisma.$executeRawUnsafe,
    transaction: prisma.$transaction,
    reportCreate: prisma.skuLifecycleCycleReport.create,
    reportFindMany: prisma.skuLifecycleCycleReport.findMany,
    trackingDeleteMany: prisma.catalogSkuTracking.deleteMany,
  };

  prisma.catalogProduct.findMany = async () => {
    if (currentRows instanceof Error) throw currentRows;
    return currentRows;
  };
  prisma.catalogProduct.count = async () => currentCount;
  prisma.catalogSkuTracking.findMany = async () => {
    // pruneOldLifecycleReports não usa este model; só o ciclo principal chama aqui.
    if (trackingRows instanceof Error) throw trackingRows;
    return trackingRows;
  };
  prisma.catalogSkuTracking.count = async () => trackingCount;
  prisma.catalogSkuTracking.createMany = async (...args) => {
    // Continua mockado por segurança (nenhum código de produção deve chamar isto
    // para CatalogSkuTracking — ver caso 7), mas não deve ser exercitado.
    writesCalled.push("catalogSkuTracking.createMany");
    return { count: args?.[0]?.data?.length || 0 };
  };
  // insertTrackedSkusBatched usa transação interativa: $transaction(async tx => ...).
  // Reencaminha `tx` para o próprio `prisma` mockado — reutiliza o mock de
  // $executeRawUnsafe abaixo em vez de precisar de um proxy `tx` à parte.
  prisma.$transaction = async (arg) => {
    if (typeof arg === "function") return arg(prisma);
    return Promise.all(arg);
  };
  prisma.$executeRawUnsafe = async (sql, ...params) => {
    writesCalled.push("$executeRawUnsafe");
    if (typeof sql === "string" && sql.includes("INSERT OR IGNORE INTO CatalogSkuTracking")) {
      // 6 params por linha: shop, sku, vendor, franchises, firstSeenAt, lastSeenAt.
      return params.length / 6;
    }
    return 0; // touchPresent/touchMissing — valor de retorno não usado pelo chamador.
  };
  prisma.skuLifecycleCycleReport.create = async (args) => {
    writesCalled.push("skuLifecycleCycleReport.create");
    state.lastReportData = args?.data ?? null;
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
    prisma.$transaction = originals.transaction;
    prisma.skuLifecycleCycleReport.create = originals.reportCreate;
    prisma.skuLifecycleCycleReport.findMany = originals.reportFindMany;
    prisma.catalogSkuTracking.deleteMany = originals.trackingDeleteMany;
  };

  return { writesCalled, state, restore };
}

/**
 * runSkuLifecycleCycle grava um marcador real em disco (seedMarkerPath) para
 * garantir que o modo semente só dispara uma vez por loja — sem isto, uma loja
 * de teste marcada como "já semeada" numa corrida anterior deste ficheiro nunca
 * mais entraria em modo semente, e o caso 4 passaria a falhar silenciosamente na
 * segunda vez que o teste corresse. Limpa antes de correr, para cada teste
 * arrancar de uma folha em branco independentemente do histórico local.
 */
async function resetSeedMarkers() {
  const dir = path.join(getDefaultConfig().paths.data, "sku-tracking-seeded");
  await fs.promises.rm(dir, { recursive: true, force: true });
}

async function main() {
  await resetSeedMarkers();

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

  await check("caso 4 — tracking vazio + catálogo real: modo semente, sem novidade reportada", async () => {
    const { writesCalled, state, restore } = patchPrisma({
      currentRows: [
        { sku: "seed-1", vendor: "V", franchises: "[]" },
        { sku: "seed-2", vendor: "V", franchises: "[]" },
      ],
      currentCount: 2,
      trackingRows: [], // tabela vazia — este é o cenário exato do incidente de 24/09
      trackingCount: 0,
    });
    try {
      const result = await runSkuLifecycleCycle("test-shop-4");
      assert.notEqual(result, null);
      assert.ok(
        writesCalled.includes("$executeRawUnsafe"),
        "modo semente escreve via INSERT OR IGNORE em lote, nunca createMany"
      );
      assert.ok(
        !writesCalled.includes("catalogSkuTracking.createMany"),
        "createMany com skipDuplicates não pode voltar a ser chamado para CatalogSkuTracking"
      );
      assert.equal(
        state.lastReportData?.newSkuCount,
        0,
        "modo semente não reporta o catálogo inteiro como novidade"
      );
      assert.equal(
        state.lastReportData?.newVipSkusJson,
        "[]",
        "modo semente não dispara destaque VIP"
      );
    } finally {
      restore();
    }
  });

  await check("caso 5 — SKU novo genuíno fora do modo semente: reportado normalmente", async () => {
    const { writesCalled, state, restore } = patchPrisma({
      currentRows: [
        { sku: "old-sku", vendor: "V", franchises: "[]" }, // continua a aparecer
        { sku: "genuinely-new", vendor: "V", franchises: "[]" }, // este é novo
      ],
      currentCount: 2,
      // tracking NÃO está vazio — há histórico real, por isso isto NÃO é modo semente.
      trackingRows: [{ sku: "old-sku", status: "active", missingCycles: 0 }],
      trackingCount: 1,
    });
    try {
      const result = await runSkuLifecycleCycle("test-shop-5");
      assert.notEqual(result, null);
      assert.ok(writesCalled.includes("$executeRawUnsafe"));
      assert.equal(
        state.lastReportData?.newSkuCount,
        1,
        "fora do modo semente, um SKU genuinamente novo tem de ser reportado"
      );
    } finally {
      restore();
    }
  });

  await check("caso 6 — insertTrackedSkusBatched processadas != total: aborta o ciclo (nada de relatório mentiroso)", async () => {
    const { restore } = patchPrisma({
      currentRows: [{ sku: "will-not-count", vendor: "V", franchises: "[]" }],
      currentCount: 1,
      trackingRows: [],
      trackingCount: 0,
    });
    // Força uma divergência entre "processadas" e "total" — simula uma escrita
    // parcial (ex: transação interrompida a meio) sem lançar uma exceção Prisma.
    const originalExecuteRawUnsafe = prisma.$executeRawUnsafe;
    prisma.$executeRawUnsafe = async () => 0; // devolve "0 linhas afetadas" propositadamente
    try {
      const result = await runSkuLifecycleCycle("test-shop-6");
      assert.equal(
        result,
        null,
        "uma contagem de INSERT que não bate com o total tem de abortar o ciclo, não gravar um relatório inconsistente"
      );
    } finally {
      prisma.$executeRawUnsafe = originalExecuteRawUnsafe;
      restore();
    }
  });

  await check("caso 6b — tracking vazio DEPOIS de já ter semeado: anomalia, não semente outra vez", async () => {
    const shop = "test-shop-6b";
    const catalogRows = [
      { sku: "seed-x", vendor: "V", franchises: "[]" },
      { sku: "seed-y", vendor: "V", franchises: "[]" },
    ];

    // 1.ª corrida: tracking vazio, catálogo real — modo semente legítimo, cria o marcador.
    {
      const { restore } = patchPrisma({
        currentRows: catalogRows,
        currentCount: 2,
        trackingRows: [],
        trackingCount: 0,
      });
      try {
        const result = await runSkuLifecycleCycle(shop);
        assert.notEqual(result, null);
      } finally {
        restore();
      }
    }

    // 2.ª corrida: tracking vazio OUTRA VEZ (ex.: bug, migração falhada, reset manual) —
    // já semeou esta loja antes, por isso NÃO pode voltar a suprimir newSkuCount.
    {
      const { state, restore } = patchPrisma({
        currentRows: catalogRows,
        currentCount: 2,
        trackingRows: [], // vazia outra vez
        trackingCount: 0,
      });
      try {
        const result = await runSkuLifecycleCycle(shop);
        assert.notEqual(result, null);
        assert.equal(
          state.lastReportData?.newSkuCount,
          2,
          "2.ª vez que a tabela aparece vazia para esta loja é anomalia — tem de reportar a sério, não voltar a suprimir como semente"
        );
      } finally {
        restore();
      }
    }
  });

  await check("caso 7 — skipDuplicates nunca reaparece no caminho de escrita do catálogo (estático)", () => {
    // Prisma não suporta `skipDuplicates` em SQLite — lança sempre
    // "Unknown argument `skipDuplicates`" (reproduzido isolado, 24/09). Era isto,
    // engolido por `safePrisma` com `rethrow:false` por omissão, que manteve
    // CatalogSkuTracking vazia durante 43 dias. Guarda estática: nenhum ficheiro de
    // produção que grava no catálogo pode voltar a usar esta opção.
    const filesToCheck = [
      "../../lib/importer/catalog/skuLifecycle.server.js",
      "../../lib/importer/catalog/catalogInsertBatch.server.js",
      "../../lib/importer/catalog/catalogProductsDb.server.js",
      "../../lib/importer/catalog/syncCatalogWithProgress.server.js",
    ];
    for (const rel of filesToCheck) {
      const abs = path.join(__dirname, rel);
      // Ignora linhas de comentário — só interessa a opção a aparecer em código real.
      const codeOnly = fs
        .readFileSync(abs, "utf8")
        .split("\n")
        .filter((line) => {
          const t = line.trim();
          return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/**"));
        })
        .join("\n");
      assert.ok(
        !codeOnly.includes("skipDuplicates"),
        `${rel} não pode usar "skipDuplicates" em código real — Prisma lança sempre em SQLite`
      );
    }
  });

  await check("caso 8 — isLifecycleReportSuspect(): V17 (lógica pura, sem mocks)", () => {
    assert.equal(
      isLifecycleReportSuspect({ newSkuCount: 26144, catalogSize: 26233, isSeedRun: false }),
      true,
      "26144 de 26233 fora do modo semente é o incidente exato de 24/09 — tem de acender"
    );
    assert.equal(
      isLifecycleReportSuspect({ newSkuCount: 26144, catalogSize: 26233, isSeedRun: true }),
      false,
      "o mesmo número em modo semente é esperado, não suspeito"
    );
    assert.equal(
      isLifecycleReportSuspect({ newSkuCount: 12000, catalogSize: 26233, isSeedRun: false }),
      false,
      "menos de metade do catálogo é novidade normal, não aciona"
    );
    assert.equal(
      isLifecycleReportSuspect({ newSkuCount: 0, catalogSize: 0, isSeedRun: false }),
      false,
      "catálogo vazio não divide por zero nem acende"
    );
  });

  if (failures) {
    console.error(`\n${failures} falha(s)`);
    process.exit(1);
  }
  console.log("\nsku-lifecycle-read-safety: todos os casos passaram");
}

main();
