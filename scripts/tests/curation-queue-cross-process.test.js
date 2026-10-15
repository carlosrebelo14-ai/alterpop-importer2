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
 *   D  Um fork faz setManualOverride (D-setManualOverride) ou bulkSetMarginPct (D-bulkSetMarginPct)
 *      enquanto o pai faz flush de overrides antigos. Espera o override mais recente.
 *   E  upsertCurationQueueBatchFromRecords sobre um item em SYNC_ERROR não muda o estado
 *      (Decisão 29, caminho em lote). E-lote grava em disco. E-fila-externa devolve a fila em memória.
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

const q = await import(QUEUE_MODULE);

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
  child.on("message", (mensagem) => {
    if (mensagem?.type === "ready") resolverReady();
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
    filho = startChild({ op: "flush-lote", items: novos, pauseMs: 3 });
    filho.done.catch(() => {});
    const gravadosAntesDoAvanco = await waitUntil(
      () => lerFilaDoDisco().filter((i) => i.sku.startsWith("N")).length === 100,
      5000
    );
    console.log(`      100 novos no disco antes de o pai avançar: ${gravadosAntesDoAvanco}`);

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
  const copiaDoPai = (await q.loadCurationQueue()).items.find((i) => i.sku === "S");
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
    // O lote (sem lock, saveFile por omissão) carrega a fila e fica parado antes de gravar.
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
async function casoD({ nome, operacaoDoFilho, predicado, verificar }) {
  escreverFila([item("P", "PENDING", { overrides: { price: 10 }, overridesUpdatedAt: ANTIGO })]);
  const copiaComOverridesAntigos = (await q.loadCurationQueue()).items.find((i) => i.sku === "P");
  const porta = atrasarPrimeiraEscritaDaFila();
  let filho;
  try {
    const pFlush = q.flushCurationQueueItems([copiaComOverridesAntigos]);
    pFlush.catch(() => {});
    if (!(await dentroDe(porta.entrou, 5000))) {
      throw new HarnessError("o flush do pai não chegou à escrita da fila em 5 s");
    }
    filho = startChild(operacaoDoFilho);
    const gravadoPeloFilho = await waitUntil(() => predicado(itemDoDisco("P")), 15000);
    console.log(`      intercalação antes do release: override do fork gravado=${gravadoPeloFilho} (${nome})`);
    porta.release();
    await comPrazo(pFlush, 20000, "flush do pai");
    await comPrazo(filho.done, 20000, "override no fork");
    await comPrazo(filho.exited, 20000, "saída do fork");
    verificar(itemDoDisco("P"));
  } finally {
    porta.release();
    porta.restaurar();
  }
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
        predicado: (entrada) => entrada?.metadata?.overrides?.price === 20,
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
        predicado: (entrada) => entrada?.metadata?.overrides?.marginPct === 25,
        verificar: (entrada) => assert.equal(entrada.metadata.overrides?.marginPct, 25, "a margem mais recente (25) desapareceu com o flush antigo"),
      })
  );
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
