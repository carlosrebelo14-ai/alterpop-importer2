#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-04 (docs/relatorios/debug-geral-14-10-2026.md, secções 4 e 9; plano em docs/planos/plano-2b.md,
 * secção 3). Escritas da fila de curadoria entre processos e fora do lock de processo.
 *
 * Casos:
 *   A  Determinístico, sem corrida de temporização. O pai (processo principal, como a UI) aprova
 *      P000 e fica parado antes de gravar a fila. Um fork (worker de indexação) faz flush de 100
 *      itens novos sobre o mesmo ficheiro. Só depois o pai avança. Espera 300 entradas, P000
 *      APPROVED e 100 novos. Hoje o avanço do pai repõe o disco antigo e apaga os 100 novos.
 *   B  O pai carrega S em PENDING. Um fork aprova S. O pai faz flush com a cópia que carregou.
 *      Espera APPROVED. Variante B2: S REJECTED em disco e AUTO_APPROVE na cópia do pai. Espera REJECTED.
 *   C  upsertCurationQueueBatchFromRecords(lote, {}) concorrente com approveProduct. A janela entre o
 *      load e o rename alarga-se com um atraso na escrita do ficheiro temporário. O atraso é um
 *      patch de fs.promises.writeFile neste teste. Não há ponto de injeção em produção.
 *   D  Um fork faz setManualOverride (D-setManualOverride) ou bulkSetMarginPct (D-bulkSetMarginPct).
 *      Depois, o pai faz flush de uma cópia com os overrides antigos. Espera o override mais recente.
 *   E  upsertCurationQueueBatchFromRecords sobre um item em SYNC_ERROR não muda o estado
 *      (Decisão 29, caminho em lote). E-lote grava em disco. E-fila-externa devolve a fila em memória.
 *   F  Decisão 35, D2: decisão humana (desfazer para PENDING) gravada depois da leitura do worker
 *      não é revertida pelo flush do worker (AUTO_APPROVE calculado sobre a leitura antiga).
 *   G  Reset Shopify (reverterTodosPublicados, ramo sem apagado). S PUBLISHED com id volta a PENDING
 *      em disco. Uma cópia lida antes do reset não repõe PUBLISHED nem o id. G-sem-id faz o mesmo para
 *      um SYNC_ERROR sem id no reset com apagado (ramo que nunca chegou à Shopify).
 *
 * Decisão 35, D1: o filho não escreve a fila. Cada escrita segue ao pai por IPC e o pai atende-a com
 * handleCurationWriteMessage (função de produção). O filho só avança quando o pai confirma.
 *
 * Resultado por caso: "passa"; "falha" (AssertionError, defeito no código atual); "erro_harness"
 * (qualquer outra exceção: timeout, filho que caiu, erro do próprio teste). Um timeout nunca conta
 * como passagem (Decisão 30).
 *
 * Uso: node scripts/tests/curation-queue-cross-process.test.js
 */
import "./_isolate-curation.js";

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { AssertionError } from "node:assert";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const DATA_DIR = process.env.CURATION_DATA_DIR;
const DATABASE_URL = process.env.DATABASE_URL;
const QUEUE_PATH = path.join(DATA_DIR, "curation-queue.json");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD_PATH = path.join(HERE, "_curation-queue-fork-child.mjs");
const QUEUE_MODULE = pathToFileURL(path.join(HERE, "..", "..", "lib", "curation", "curationQueue.server.js")).href;
const RESET_MODULE = pathToFileURL(path.join(HERE, "..", "..", "lib", "importer", "shopify", "shopifyReset.server.js")).href;

const q = await import(QUEUE_MODULE);
const reset = await import(RESET_MODULE);

const AGORA = new Date().toISOString();
const ANTIGO = "2026-10-01T00:00:00.000Z";

class HarnessError extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = "HarnessError";
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Espera até o predicado ser verdadeiro ou o prazo acabar. Não lança: devolve true ou false. */
async function waitUntil(predicado, ms) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (predicado()) return true;
    await sleep(5);
  }
  return predicado();
}

/** true se a promessa acabar (resolve ou rejeita) dentro do prazo; false se não acabar. */
async function dentroDe(promessa, ms) {
  let timer;
  const prazo = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const acabou = promessa.then(
    () => true,
    () => true
  );
  const resultado = await Promise.race([acabou, prazo]);
  clearTimeout(timer);
  return resultado;
}

/**
 * Espera a promessa durante no máximo ms. Estouro de prazo é erro de harness, nunca passagem
 * (Decisão 30): um filho preso não pode dar verde.
 */
function comPrazo(promessa, ms, descricao) {
  let timer;
  const prazo = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new HarnessError(`prazo de ${ms} ms esgotado: ${descricao}`)), ms);
  });
  return Promise.race([promessa, prazo]).finally(() => clearTimeout(timer));
}

function escreverFila(items) {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify({ version: 1, updatedAt: null, items }), "utf8");
  q.invalidateCurationMemoryCache();
}

function lerFilaDoDisco() {
  return JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8")).items;
}

function itemDoDisco(sku) {
  return lerFilaDoDisco().find((i) => i.sku === sku);
}

function item(sku, status = "PENDING", metadata = {}) {
  return {
    sku,
    title_en: sku,
    status,
    reason: "teste_cross_process",
    shopifyStatus: status === "APPROVED" ? "ACTIVE" : "DRAFT",
    metadata: {
      vendor: "TESTVENDOR",
      category: "Toys",
      approvedAt: null,
      rejectedAt: null,
      queuedAt: AGORA,
      ...metadata,
    },
  };
}

/** Registo de entrada para o caminho em lote. Sem regra que o aprove ou recuse: fica PENDING. */
function registo(sku) {
  return { sku, title: "Produto de teste", vendor: "TESTVENDOR", categoryMain: "Toys", netPrice: 10, grossPrice: 12, availableQuantity: 5 };
}

const filhos = new Set();
process.on("exit", () => {
  for (const filho of filhos) filho.kill("SIGKILL");
});

/**
 * Arranca um fork real de scripts/tests/_curation-queue-fork-child.mjs sobre a mesma fila.
 * ready resolve quando o filho importou a fila (só com waitGo). done resolve com a operação
 * concluída. exited resolve quando o processo sai. go() liga o filho quando ready estiver resolvida.
 */
function startChild(payload, { waitGo = false } = {}) {
  const child = fork(CHILD_PATH, [JSON.stringify({ ...payload, waitGo, dataDir: DATA_DIR, databaseUrl: DATABASE_URL, queueModule: QUEUE_MODULE })], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, CURATION_DATA_DIR: DATA_DIR, DATABASE_URL },
  });
  filhos.add(child);
  let saida = "";
  const guardarSaida = (chunk) => {
    saida = (saida + chunk).slice(-2000);
  };
  child.stdout.on("data", guardarSaida);
  child.stderr.on("data", guardarSaida);
  child.on("error", () => {});

  let resolverReady;
  let rejeitarReady;
  let resolverDone;
  let rejeitarDone;
  const ready = new Promise((resolve, reject) => {
    resolverReady = resolve;
    rejeitarReady = reject;
  });
  const done = new Promise((resolve, reject) => {
    resolverDone = resolve;
    rejeitarDone = reject;
  });
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      filhos.delete(child);
      const erro = new HarnessError(`filho saiu sem concluir (code=${code}, signal=${signal}). Última saída: ${saida.trim()}`);
      rejeitarReady(erro);
      rejeitarDone(erro);
      resolve({ code, signal });
    });
  });
  // Decisão 35 (D1): as escritas do filho chegam aqui e são atendidas pelo pai com a função de
  // produção. O filho só recebe a resposta depois de a fila confirmar (ack por IPC).
  let pedidosRecebidos = 0;
  child.on("message", (mensagem) => {
    if (mensagem?.type === "curation-write") {
      pedidosRecebidos += 1;
      q.handleCurationWriteMessage(mensagem, (resposta) => child.send(resposta, () => {}));
    } else if (mensagem?.type === "ready") resolverReady();
    else if (mensagem?.type === "done") resolverDone();
    else if (mensagem?.type === "error") {
      const erro = new HarnessError(`filho falhou: ${mensagem.message}`);
      rejeitarReady(erro);
      rejeitarDone(erro);
    }
  });
  ready.catch(() => {});
  done.catch(() => {});
  return {
    ready,
    done,
    exited,
    pedidosRecebidos: () => pedidosRecebidos,
    go: () => child.send({ type: "go" }),
  };
}

/**
 * Atrasa a primeira escrita do ficheiro temporário da fila (a que ocorre depois do load e antes do
 * rename) até release(). Patch de fs.promises.writeFile neste processo de teste. Não toca em produção.
 */
function atrasarPrimeiraEscritaDaFila() {
  const real = fsp.writeFile;
  let chamadas = 0;
  let marcarEntrou;
  const entrou = new Promise((resolve) => {
    marcarEntrou = resolve;
  });
  let abrir;
  const aberta = new Promise((resolve) => {
    abrir = resolve;
  });
  fsp.writeFile = async function escritaAtrasada(ficheiro, ...resto) {
    const nome = String(ficheiro);
    if (nome.startsWith(`${QUEUE_PATH}.`) && nome.endsWith(".tmp")) {
      chamadas += 1;
      if (chamadas === 1) {
        marcarEntrou();
        await aberta;
      }
    }
    return real.call(this, ficheiro, ...resto);
  };
  return {
    entrou,
    release: () => abrir(),
    restaurar: () => {
      fsp.writeFile = real;
    },
  };
}

const resultados = [];

// Lacuna de IPC: o worker recebe do principal a entrada gravada, não só o ok.
async function casoEntradaVoltaPelaIPC() {
  const dir = fs.mkdtempSync(path.join(DATA_DIR, "entrada-ipc-"));
  const outFile = path.join(dir, "entrada.json");
  try {
    const filho = startChild({ op: "upsertRecord", record: registo("IPC1"), outFile });
    await comPrazo(filho.done, 20000, "upsertRecord no fork");
    await comPrazo(filho.exited, 20000, "saída do fork");
    const devolvida = JSON.parse(fs.readFileSync(outFile, "utf8"));
    assert.equal(devolvida?.sku, "IPC1", `o worker não recebeu a entrada gravada: ${JSON.stringify(devolvida)}`);
    assert.equal(devolvida.status, "PENDING");
    assert.equal(itemDoDisco("IPC1").status, "PENDING", "a entrada tem de estar gravada em disco");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function caso(id, nome, fn) {
  try {
    await fn();
    resultados.push({ id, nome, resultado: "passa" });
    console.log(`  passa           ${id}  ${nome}`);
  } catch (err) {
    const resultado = err instanceof AssertionError ? "falha" : "erro_harness";
    resultados.push({ id, nome, resultado, detalhe: err.message });
    console.log(`  ${resultado.padEnd(15)} ${id}  ${nome}\n      ${err.message.split("\n").join("\n      ")}`);
  }
}

// ---------------------------------------------------------------------------
// A: dois forks reais, perda de escritas entre processos
// ---------------------------------------------------------------------------
async function casoA() {
  const pendentes = Array.from({ length: 200 }, (_, i) => item(`P${String(i).padStart(3, "0")}`));
  escreverFila(pendentes);
  const novos = Array.from({ length: 100 }, (_, i) => item(`N${String(i).padStart(3, "0")}`));

  // Pai: aprovação de P000 fica parada antes de gravar, com a fila já carregada (200 PENDING).
  const porta = atrasarPrimeiraEscritaDaFila();
  let pAprovacao;
  let filho;
  try {
    pAprovacao = q.approveProduct("P000");
    pAprovacao.catch(() => {});
    if (!(await dentroDe(porta.entrou, 5000))) {
      throw new HarnessError("a aprovação do pai não chegou à escrita da fila em 5 s");
    }

    // Worker (fork): flush de 100 itens novos sobre o mesmo ficheiro, enquanto o pai está parado.
    // Com escritor único o pedido chega ao pai e espera pelo lock: nada é gravado antes do avanço.
    filho = startChild({ op: "flush-lote", items: novos, pauseMs: 3 });
    filho.done.catch(() => {});
    // Janela: espera que o worker envie os 100 lotes, ou 4 s. Com escritor único o worker fica preso
    // no primeiro pedido até o pai avançar, e a janela esgota-se. Se a aprovação não tiver lock, os
    // lotes escritos dentro da janela são apagados pela escrita atrasada do pai: é o que o caso apanha.
    await waitUntil(() => filho.pedidosRecebidos() >= novos.length, 4000);
    const novosAntesDoAvanco = lerFilaDoDisco().filter((i) => i.sku.startsWith("N")).length;
    console.log(`      pedidos do worker recebidos antes de o pai avançar: ${filho.pedidosRecebidos()}; novos no disco: ${novosAntesDoAvanco}`);

    // Só agora o pai avança e grava a sua cópia. Com um escritor único, esta espera não cruza o pai.
    porta.release();
    await comPrazo(filho.done, 20000, "flush do worker");
    await comPrazo(filho.exited, 20000, "saída do worker");
    await comPrazo(pAprovacao, 20000, "aprovação do pai");
  } finally {
    porta.release();
    porta.restaurar();
  }

  const itens = lerFilaDoDisco();
  const aprovados = itens.filter((i) => i.status === "APPROVED").map((i) => i.sku);
  const novosNoDisco = itens.filter((i) => i.sku.startsWith("N")).length;
  console.log(`      final: ${itens.length} entradas (esperado 300), ${novosNoDisco} novos (esperado 100), APPROVED ${JSON.stringify(aprovados)}`);
  assert.equal(
    novosNoDisco,
    100,
    `o pai repôs o disco antigo e apagou ${100 - novosNoDisco} de 100 itens novos gravados pelo worker (entradas: ${itens.length}, esperado 300)`
  );
  assert.equal(itens.length, 300, "entradas da fila");
  assert.deepEqual(aprovados, ["P000"], "a aprovação do pai tem de ficar");
}

// ---------------------------------------------------------------------------
// B: o pai faz flush com uma cópia antiga
// ---------------------------------------------------------------------------
async function casoB() {
  escreverFila([item("S"), item("OUTRO")]);
  // Cópia (snapshot) do pai. Um clone: com IPC o fork corre no processo do pai e alteraria a própria cache.
  const copiaDoPai = structuredClone((await q.loadCurationQueue()).items.find((i) => i.sku === "S"));
  assert.equal(copiaDoPai.status, "PENDING", "a cópia do pai tem de começar em PENDING");

  const filho = startChild({ op: "approveProduct", sku: "S" });
  await comPrazo(filho.done, 20000, "approveProduct no fork");
  await comPrazo(filho.exited, 20000, "saída do fork");
  assert.equal(itemDoDisco("S").status, "APPROVED", "o fork tem de ter aprovado S em disco");

  q.invalidateCurationMemoryCache();
  await q.flushCurationQueueItems([copiaDoPai]);
  assert.equal(itemDoDisco("S").status, "APPROVED", "o flush com a cópia antiga não pode repor PENDING");
}

async function casoB2() {
  escreverFila([item("S")]);
  // Cópia do pai com o resultado de AUTO_APPROVE, como o worker o calcularia.
  const copiaDoPai = item("S", "APPROVED", {
    smartRule: true,
    smartAction: "AUTO_APPROVE",
    smartRuleId: "regra-teste",
    approvedAt: AGORA,
  });

  const filho = startChild({ op: "rejectProduct", sku: "S" });
  await comPrazo(filho.done, 20000, "rejectProduct no fork");
  await comPrazo(filho.exited, 20000, "saída do fork");
  assert.equal(itemDoDisco("S").status, "REJECTED", "o fork tem de ter rejeitado S em disco");

  q.invalidateCurationMemoryCache();
  await q.flushCurationQueueItems([copiaDoPai]);
  assert.equal(itemDoDisco("S").status, "REJECTED", "a decisão humana em disco (REJECTED) não pode ser reposta como APPROVED pela cópia do pai");
}

// ---------------------------------------------------------------------------
// C: lote com {} concorrente com approveProduct, na mesma janela de escrita
// ---------------------------------------------------------------------------
async function casoC() {
  escreverFila([item("S"), item("OUTRO")]);
  const porta = atrasarPrimeiraEscritaDaFila();
  try {
    // O lote (com lock, saveFile por omissão, via mutateCurationQueue) carrega a fila e fica parado antes de gravar.
    const pLote = q.upsertCurationQueueBatchFromRecords([registo("S")], {});
    pLote.catch(() => {});
    if (!(await dentroDe(porta.entrou, 5000))) {
      throw new HarnessError("o lote não chegou à escrita da fila em 5 s");
    }
    // Outra escrita conclui e invalida a cache. A aprovação carrega a fila de novo, do disco.
    const pOutro = q.markQueueItemSyncError("OUTRO", "erro de teste");
    pOutro.catch(() => {});
    const outroGravado = await waitUntil(() => itemDoDisco("OUTRO")?.status === "SYNC_ERROR", 2000);
    const pAprovacao = q.approveProduct("S");
    pAprovacao.catch(() => {});
    const aprovacaoGravada = await waitUntil(() => itemDoDisco("S")?.status === "APPROVED", 2000);
    console.log(
      `      intercalação antes do release: OUTRO gravado=${outroGravado}, aprovação de S gravada=${aprovacaoGravada}`
    );
    porta.release();
    await comPrazo(Promise.all([pLote, pOutro, pAprovacao]), 20000, "lote, SYNC_ERROR e aprovação");
    assert.equal(
      itemDoDisco("S").status,
      "APPROVED",
      "a aprovação de S foi apagada pela escrita do lote, que tinha carregado a fila antes dela"
    );
  } finally {
    porta.release();
    porta.restaurar();
  }
}

// ---------------------------------------------------------------------------
// D: o pai faz flush de overrides antigos enquanto um fork escreve um override novo
// ---------------------------------------------------------------------------
async function casoD({ nome, operacaoDoFilho, verificar }) {
  escreverFila([item("P", "PENDING", { overrides: { price: 10 }, overridesUpdatedAt: ANTIGO })]);
  // Cópia que o pai carregou antes do override novo (clone, pelo mesmo motivo que em B).
  const copiaComOverridesAntigos = structuredClone((await q.loadCurationQueue()).items.find((i) => i.sku === "P"));
  // Override novo escrito por outro processo (fork), confirmado antes de a cópia antiga ser gravada.
  const filho = startChild(operacaoDoFilho);
  await comPrazo(filho.done, 20000, `${nome} no fork`);
  await comPrazo(filho.exited, 20000, "saída do fork");
  await q.flushCurationQueueItems([copiaComOverridesAntigos]);
  verificar(itemDoDisco("P"));
}

// ---------------------------------------------------------------------------
// E: SYNC_ERROR no caminho em lote (Decisão 29)
// ---------------------------------------------------------------------------
async function casoE(via) {
  escreverFila([item("E1", "SYNC_ERROR", { syncError: "SKU ausente do catálogo indexado", syncErrorAt: AGORA })]);
  if (via === "lote") {
    await q.upsertCurationQueueBatchFromRecords([registo("E1")], {});
    const entrada = itemDoDisco("E1");
    assert.equal(entrada.status, "SYNC_ERROR", "reindex em lote não pode tirar SYNC_ERROR sem revisão humana");
    assert.equal(entrada.metadata.syncError, "SKU ausente do catálogo indexado", "o erro de publicação original tem de ficar intacto");
  } else {
    const fila = await q.loadCurationQueue();
    const devolvida = await q.upsertCurationQueueBatchFromRecords([registo("E1")], { queue: fila, saveFile: false });
    const entrada = devolvida.items.find((i) => i.sku === "E1");
    assert.equal(entrada.status, "SYNC_ERROR", "reindex em lote com fila externa não pode tirar SYNC_ERROR");
  }
}

// ---------------------------------------------------------------------------
// F: decisão humana depois da leitura do worker não é revertida (D2)
// ---------------------------------------------------------------------------
async function casoF() {
  escreverFila([item("F1")]);
  // Leitura do worker: anterior à decisão humana abaixo.
  const lidoEm = Date.now();
  await sleep(5);
  // Decisão humana que desfaz para PENDING (estado não protegido): fica com statusChangedAt.
  await q.restoreQueueSnapshots([{ sku: "F1", status: "PENDING", shopifyStatus: "DRAFT", metadata: { vendor: "TESTVENDOR" } }]);
  assert.equal(itemDoDisco("F1").status, "PENDING", "pré-condição: a decisão humana tem de ter ficado gravada");
  // O worker, com a leitura de antes da decisão, calculou APPROVED por regra automática e tem um título novo.
  const calculado = { ...item("F1", "APPROVED", { smartRule: true, smartAction: "AUTO_APPROVE", approvedAt: AGORA }), title_en: "Título novo" };
  await q.flushCurationQueueItems([calculado], { readAt: lidoEm });
  const f1 = itemDoDisco("F1");
  assert.equal(f1.status, "PENDING", "a decisão humana posterior à leitura do worker não pode ser revertida por AUTO_APPROVE");
  assert.equal(f1.title_en, "Título novo", "os campos de catálogo do worker têm de chegar ao disco");
}

// ---------------------------------------------------------------------------
// G: reset Shopify (D2). Cópia lida antes do reset não repõe o estado antigo depois do reset
// ---------------------------------------------------------------------------
async function casoG() {
  escreverFila([item("S", "PUBLISHED", { shopifyProductId: "gid://shopify/Product/501", publishedAt: ANTIGO })]);
  // Leitura do worker: anterior ao reset. Cópia (clone) do item PUBLISHED com o id da Shopify.
  const lidoEm = Date.now();
  const copiaDoPai = structuredClone((await q.loadCurationQueue()).items.find((i) => i.sku === "S"));
  assert.equal(copiaDoPai.status, "PUBLISHED", "pré-condição: a cópia tem de estar PUBLISHED");

  // Reset Shopify, ramo sem apagado (targetStatus PENDING). S volta a PENDING, sem id, em disco.
  const revertidos = await reset.revertAllPublishedInQueue({ targetStatus: "PENDING" });
  assert.equal(revertidos, 1, "o reset tem de reverter S");
  assert.equal(itemDoDisco("S").status, "PENDING", "pré-condição: o reset põe S em PENDING em disco");

  // Flush da cópia antiga, lida antes do reset. Não pode repor PUBLISHED nem o id da Shopify.
  q.invalidateCurationMemoryCache();
  await q.flushCurationQueueItems([copiaDoPai], { readAt: lidoEm });
  const apos = itemDoDisco("S");
  assert.equal(apos.status, "PENDING", "o flush com a cópia PUBLISHED repôs PUBLISHED depois do reset");
  assert.equal(apos.metadata.shopifyProductId, null, "o flush repôs o id da Shopify que o reset limpou");
}

async function casoGSemId() {
  escreverFila([item("Z", "SYNC_ERROR", { syncError: "erro de teste", syncErrorAt: AGORA })]);
  const lidoEm = Date.now();
  const copiaDoPai = structuredClone((await q.loadCurationQueue()).items.find((i) => i.sku === "Z"));
  assert.equal(copiaDoPai.status, "SYNC_ERROR", "pré-condição: a cópia tem de estar em SYNC_ERROR");

  // Reset com apagado. D44 (Decisão 35): SYNC_ERROR fica como está, com ou sem id. O reset não o reverte.
  const revertidos = await reset.revertAllPublishedInQueue({ deletedInAdmin: true });
  assert.equal(revertidos, 0, "o reset não reverte SYNC_ERROR (D44)");
  assert.equal(itemDoDisco("Z").status, "SYNC_ERROR", "pré-condição: Z continua SYNC_ERROR em disco");

  q.invalidateCurationMemoryCache();
  await q.flushCurationQueueItems([copiaDoPai], { readAt: lidoEm });
  assert.equal(itemDoDisco("Z").status, "SYNC_ERROR", "o flush com a cópia SYNC_ERROR não o altera depois do reset");
}

async function main() {
  await caso("A", "dois forks, 200 PENDING, 100 aprovações e 100 novos (3 rondas)", casoA);
  await caso("B", "flush do pai com cópia PENDING depois de um fork aprovar S", casoB);
  await caso("B2", "flush do pai com AUTO_APPROVE não repõe S sobre REJECTED em disco", casoB2);
  await caso("C", "lote com {} concorrente com approveProduct, com atraso na escrita", casoC);
  await caso(
    "D-setManualOverride",
    "flush de overrides antigos não repõe o override novo do fork",
    () =>
      casoD({
        nome: "setManualOverride",
        operacaoDoFilho: { op: "setManualOverride", sku: "P", overrides: { price: 20 }, meta: { by: "filho", reason: "teste D" } },
        verificar: (entrada) => assert.equal(entrada.metadata.overrides.price, 20, "o override de preço mais recente (20) foi reposto para 10 pelo flush antigo"),
      })
  );
  await caso(
    "D-bulkSetMarginPct",
    "flush de overrides antigos não repõe a margem nova do fork",
    () =>
      casoD({
        nome: "bulkSetMarginPct",
        operacaoDoFilho: { op: "bulkSetMarginPct", skus: ["P"], marginPct: 25 },
        verificar: (entrada) => assert.equal(entrada.metadata.overrides?.marginPct, 25, "a margem mais recente (25) desapareceu com o flush antigo"),
      })
  );
  await caso("F", "decisão humana depois da leitura do worker não é revertida pelo flush (D2)", casoF);
  await caso("IPC1", "upsert pelo worker devolve a entrada gravada pelo principal (IPC)", casoEntradaVoltaPelaIPC);
  await caso("G", "reset sem apagado: cópia PUBLISHED lida antes do reset não repõe PUBLISHED nem o id", casoG);
  await caso("G-sem-id", "reset com apagado deixa SYNC_ERROR sem id (D44): o flush com a cópia não o repõe", casoGSemId);
  await caso("E-lote", "upsert em lote sobre SYNC_ERROR mantém o estado e o erro (fila em disco)", () => casoE("lote"));
  await caso("E-fila-externa", "upsert em lote sobre SYNC_ERROR mantém o estado (fila externa, sem gravar)", () => casoE("externa"));

  console.log("\nRESUMO");
  for (const r of resultados) {
    console.log(`  ${r.id.padEnd(18)} ${r.resultado.padEnd(15)} ${r.nome}`);
  }
  const nao = resultados.filter((r) => r.resultado !== "passa").length;
  if (nao) {
    console.error(`\n${nao} caso(s) não passam (falha ou erro_harness)`);
    process.exit(1);
  }
  console.log("\ncuration-queue-cross-process: todos os casos passaram");
}

await main();
