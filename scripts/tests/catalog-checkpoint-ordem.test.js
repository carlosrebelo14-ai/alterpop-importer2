#!/usr/bin/env node
/* eslint-env node */
/**
 * Lote 2b-1, Decisão 4 do arquiteto (D5). O checkpoint da indexação só avança depois do flush
 * confirmado da fila de curadoria.
 *
 * - confirmarJanelaDaFila (syncCatalogWithProgress.server.js): o checkpoint sai só depois do ack
 *   do flush. Com ack atrasado, o checkpoint não sai antes (C1). Com flush rejeitado, não sai (C2).
 * - estadoDoProgressoDoWorker (catalogRebuildStatus.server.js): um evento de progresso não traz
 *   checkpoint. O progresso vai à frente do flush e não pode ser ponto de retoma (C4).
 * - canResumeCatalogRebuild e pontoDeRetoma: a retoma só usa checkpointScanned, nunca scanned (C5, C6).
 * - decidirAtualizacaoDeProgresso (indexingStream.server.js): a função pura do evento `progress`. Executa a
 *   função real do handler, não só estadoDoProgressoDoWorker. O estado nunca traz checkpoint (C7).
 * - tratarProgressoDoWorker (indexingStream.server.js) é o case `progress` com dependências falsas, sem fork.
 *   A escrita que ele pede não leva checkpoint (C8 e C9).
 *
 * Sem CSV, SQLite nem Prisma reais. O flush é falso e o ack é controlado pelo teste.
 *
 * Uso: node scripts/tests/catalog-checkpoint-ordem.test.js
 */
import "./_isolate-curation.js";

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");
const modulo = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);

const sync = await modulo("lib/importer/catalog/syncCatalogWithProgress.server.js");
const estado = await modulo("lib/importer/catalog/catalogRebuildStatus.server.js");
const indexacao = await modulo("lib/importer/catalog/indexingStream.server.js");

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const LOJA = "loja-teste";

/** Dependências falsas de tratarProgressoDoWorker. Regista cada chamada para o teste ver o que saiu. */
function depsDoProgresso({ estadoAtual = null } = {}) {
  const registo = { emitidos: [], memoria: [], escritas: [] };
  const deps = {
    shop: LOJA,
    estadoAtual,
    emitir: (shop, evento) => {
      registo.emitidos.push({ shop, evento });
    },
    setInMemoryStatus: (shop, status) => {
      registo.memoria.push({ shop, status });
    },
    writeCatalogRebuildStatus: async (shop, status) => {
      registo.escritas.push({ shop, status });
    },
  };
  return { deps, registo };
}

let falhas = 0;
async function caso(nome, fn) {
  try {
    await fn();
    console.log(`  ok  ${nome}`);
  } catch (err) {
    falhas += 1;
    console.error(`FAIL  ${nome}\n      ${err.message}`);
  }
}

async function main() {
  await caso("C1 ack atrasado: o checkpoint não sai antes de a fila confirmar o lote", async () => {
    const eventos = [];
    let libertarAck;
    let ackConfirmado = false;
    const flush = (itens) => {
      eventos.push(["flush", itens.length]);
      return new Promise((resolve) => {
        libertarAck = () => {
          ackConfirmado = true;
          resolve();
        };
      });
    };
    const janela = sync.confirmarJanelaDaFila({
      pending: [{ sku: "A" }],
      ponto: { indexed: 500, scanned: 500 },
      flush,
      onCheckpoint: (p) => eventos.push(["checkpoint", p.scanned, ackConfirmado]),
    });
    await esperar(20);
    assert.deepEqual(eventos, [["flush", 1]]);
    libertarAck();
    await janela;
    assert.deepEqual(eventos, [
      ["flush", 1],
      ["checkpoint", 500, true],
    ]);
  });

  await caso("C2 flush rejeitado: o checkpoint não sai", async () => {
    const eventos = [];
    await assert.rejects(
      sync.confirmarJanelaDaFila({
        pending: [{ sku: "B" }],
        ponto: { indexed: 500, scanned: 500 },
        flush: async () => {
          throw new Error("ack negado pelo processo principal");
        },
        onCheckpoint: () => eventos.push("checkpoint"),
      }),
      /ack negado/
    );
    assert.deepEqual(eventos, []);
  });

  await caso("C3 controlo: janela sem itens pendentes não chama o flush e publica o ponto", async () => {
    const eventos = [];
    await sync.confirmarJanelaDaFila({
      pending: [],
      ponto: { indexed: 0, scanned: 0 },
      flush: async () => eventos.push("flush"),
      onCheckpoint: (p) => eventos.push(["checkpoint", p.scanned]),
    });
    assert.deepEqual(eventos, [["checkpoint", 0]]);
  });

  await caso("C4 progresso do worker não traz checkpoint (vai à frente do flush)", async () => {
    const patch = estado.estadoDoProgressoDoWorker({ phase: "streaming", indexed: 2000, scanned: 2000 });
    assert.equal("checkpointScanned" in patch, false);
    assert.equal("checkpointIndexed" in patch, false);
    assert.equal(patch.scanned, 2000);
    assert.equal(patch.state, "running");
  });

  await caso("C5 retoma: estado falhado só se retoma com checkpoint, não com scanned do progresso", async () => {
    assert.equal(estado.canResumeCatalogRebuild({ state: "failed", indexing: false, scanned: 2000 }), false);
    assert.equal(
      estado.canResumeCatalogRebuild({ state: "failed", indexing: false, scanned: 2000, checkpointScanned: 1500 }),
      true
    );
  });

  await caso("C6 ponto de retoma vem só de checkpointScanned", async () => {
    assert.equal(estado.pontoDeRetoma({ state: "failed", scanned: 2000 }), 0);
    assert.equal(estado.pontoDeRetoma({ checkpointScanned: null, scanned: 2000 }), 0);
    assert.equal(estado.pontoDeRetoma({ checkpointScanned: 1500, scanned: 2000 }), 1500);
    assert.equal(estado.pontoDeRetoma(null), 0);
  });

  await caso("C7 função pura do progresso: o evento do worker não traz checkpoint, nem no estado nem na decisão", async () => {
    const decisao = indexacao.decidirAtualizacaoDeProgresso({ phase: "streaming", indexed: 2000, scanned: 2000, checkpointScanned: 1500 });
    assert.equal(decisao.atualizar, true);
    assert.equal("checkpointScanned" in decisao.estado, false);
    assert.equal("checkpointIndexed" in decisao.estado, false);
    assert.equal(decisao.estado.scanned, 2000);
    assert.equal(decisao.estado.state, "running");
    // Sem indexed, o progresso não atualiza a memória (é o mesmo que o handler fazia com `msg.indexed != null`).
    assert.deepEqual(indexacao.decidirAtualizacaoDeProgresso({ phase: "streaming", scanned: 2000 }), { atualizar: false, estado: null });
  });

  await caso("C8 tratamento do progresso: a escrita não leva checkpoint e o estado devolvido junta o estado atual", async () => {
    const { deps, registo } = depsDoProgresso({
      estadoAtual: { state: "running", indexing: true, resumedFrom: 1500, scanned: 1500, totalRows: 1500 },
    });
    const novo = indexacao.tratarProgressoDoWorker({ phase: "streaming", indexed: 2000, scanned: 2000 }, deps);

    assert.deepEqual(registo.emitidos, [
      { shop: LOJA, evento: { type: "progress", phase: "streaming", indexed: 2000, scanned: 2000 } },
    ]);
    assert.equal(registo.escritas.length, 1);
    const escrita = registo.escritas[0];
    assert.equal("checkpointScanned" in escrita.status, false);
    assert.equal("checkpointIndexed" in escrita.status, false);
    assert.deepEqual(escrita.status, {});
    assert.equal(registo.memoria.length, 1);
    assert.equal("checkpointScanned" in registo.memoria[0].status, false);
    assert.equal("checkpointIndexed" in registo.memoria[0].status, false);
    assert.deepEqual(novo, {
      state: "running",
      indexing: true,
      resumedFrom: 1500,
      scanned: 2000,
      totalRows: 2000,
      phase: "streaming",
    });
  });

  await caso("C9 progresso sem indexed: emite o evento, mas não atualiza a memória nem pede escrita", async () => {
    const estadoAtual = { state: "running", indexing: true, scanned: 5 };
    const { deps, registo } = depsDoProgresso({ estadoAtual });
    const novo = indexacao.tratarProgressoDoWorker({ phase: "resuming", scanned: 10 }, deps);

    assert.equal(registo.emitidos.length, 1);
    assert.equal(registo.emitidos[0].evento.type, "progress");
    assert.deepEqual(registo.memoria, []);
    assert.deepEqual(registo.escritas, []);
    assert.equal(novo, estadoAtual);
  });

  if (falhas) {
    console.error(`\n${falhas} falha(s)`);
    process.exit(1);
  }
  console.log("\ncatalog-checkpoint-ordem: todos os casos passaram");
}

main();
