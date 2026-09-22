#!/usr/bin/env node
/**
 * Auditoria 2026-09-22 — `processNextQueuedJob` (backgroundWorker.server.js) marcava
 * `workerBusy = true` só DEPOIS do primeiro await (o findFirst() do job "queued").
 * O setInterval chama esta função a cada 1500ms; se o findFirst demorar mais do que
 * isso — plausível, dado que o busy_timeout do SQLite é 5000ms e a ligação é
 * partilhada com o worker de reindexação e o servidor HTTP — duas execuções
 * sobrepostas passavam ambas pelo `if (workerBusy) return;` com "false" e podiam
 * apanhar e arrancar o MESMO job em paralelo.
 *
 * Este teste não precisa de um job real: só confirma que, com um findFirst() lento,
 * chamar processNextQueuedJob() duas vezes de seguida (sem esperar pela primeira)
 * só deixa a PRIMEIRA chamada consultar a base de dados — a segunda tem de ser
 * bloqueada pelo guard antes de qualquer await, não depois.
 *
 * Monkey-patcha `prisma.backgroundImportJob.findFirst` diretamente no singleton
 * (mesmo padrão de scripts/tests/sku-lifecycle-read-safety.test.js), restaura no fim.
 *
 * Uso: node scripts/tests/background-worker-race-safety.test.js
 */
import assert from "node:assert/strict";
import { prisma } from "../../lib/prisma/prismaSafe.server.js";
import { processNextQueuedJob } from "../../lib/importer/jobs/backgroundWorker.server.js";

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const originalFindFirst = prisma.backgroundImportJob.findFirst;

  await check("duas chamadas sobrepostas a processNextQueuedJob() só deixam UMA consultar a BD", async () => {
    let findFirstCalls = 0;
    prisma.backgroundImportJob.findFirst = async () => {
      findFirstCalls += 1;
      // Simula uma query lenta (contenção real de SQLite) — mais longa do que o
      // intervalo de 1500ms do setInterval em produção, para expor a corrida.
      await sleep(50);
      return null; // "sem job na fila" — não precisamos de correr um import real
    };

    // Chamadas disparadas de seguida, sem esperar pela primeira — é exatamente o que
    // duas execuções sobrepostas do setInterval fazem.
    const call1 = processNextQueuedJob();
    await sleep(5); // dá tempo ao guard síncrono da 1ª chamada correr antes da 2ª
    const call2 = processNextQueuedJob();

    await Promise.all([call1, call2]);

    assert.equal(
      findFirstCalls,
      1,
      `esperava 1 chamada a findFirst() (a 2ª execução devia ter sido bloqueada pelo guard workerBusy), recebeu ${findFirstCalls}`
    );
  });

  await check("depois de terminar, o worker volta a aceitar uma nova chamada (guard não fica preso a true)", async () => {
    let findFirstCalls = 0;
    prisma.backgroundImportJob.findFirst = async () => {
      findFirstCalls += 1;
      return null;
    };

    await processNextQueuedJob();
    await processNextQueuedJob();

    assert.equal(findFirstCalls, 2, `esperava 2 chamadas (uma por execução sequencial), recebeu ${findFirstCalls}`);
  });

  prisma.backgroundImportJob.findFirst = originalFindFirst;

  if (failures) {
    console.error(`\n${failures} falha(s)`);
    process.exit(1);
  }
  console.log("\nbackground-worker-race-safety: todos os casos passaram");
}

main();
