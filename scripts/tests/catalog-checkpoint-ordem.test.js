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

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  if (falhas) {
    console.error(`\n${falhas} falha(s)`);
    process.exit(1);
  }
  console.log("\ncatalog-checkpoint-ordem: todos os casos passaram");
}

main();
