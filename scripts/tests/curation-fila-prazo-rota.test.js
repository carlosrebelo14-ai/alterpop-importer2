#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-56. A espera pela fila de curadoria tem prazo. As rotas do painel esperam 30 s
 * (comPrazoDeRota); o fundo espera 10 min (prazoDoLock). Antes, a espera em processo (cadeia
 * queueLock) não tinha prazo nenhum, e a rota ficava pendurada atrás de um lote longo.
 *
 * Casos:
 *   P1  Rota com a fila ocupada por mais tempo que o prazo de rota: falha com
 *       CURATION_QUEUE_LOCK_TIMEOUT no prazo, com a marca "[fila] espera esgotada", sem esperar
 *       pelo detentor.
 *   P2  O pedido que desistiu na cadeia não corre quando lhe chega a vez: não escreve e não toma o
 *       lock.
 *   P3  O mesmo prazo não corta o fundo: um processo de fundo espera além do prazo de rota e
 *       escreve.
 *   P4  Secção que já começou não é interrompida pelo prazo: a rota que entra com o lock livre
 *       devolve o resultado mesmo depois do prazo.
 *   P5  Rota com a fila livre escreve e devolve o resultado.
 *   P6  Desiste enquanto espera o ficheiro: o pedido não escreve e liberta o lock que tomou depois
 *       do prazo.
 *   P7  Prazos por omissão: rota 30 s, fundo 10 min, e são prazos separados.
 *   S1  As rotas de escrita do painel embrulham cada escrita em comPrazoDeRota, e não há chamada
 *       nua às funções de escrita.
 *
 * Os prazos baixos vêm de CURATION_QUEUE_LOCK_PRAZO_ROTA_MS e CURATION_QUEUE_LOCK_PRAZO_MS (lidos a
 * cada chamada). Não toca nos dados reais: usa CURATION_DATA_DIR isolado.
 *
 * Uso: node scripts/tests/curation-fila-prazo-rota.test.js
 */
import "./_isolate-curation.js";

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { semComentarios } from "./_sem-comentarios.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");
const DATA_DIR = process.env.CURATION_DATA_DIR;
const QUEUE_PATH = path.join(DATA_DIR, "curation-queue.json");
const LOCK_PATH = path.join(DATA_DIR, "curation-queue.lock");
const QUEUE_MODULE = pathToFileURL(path.join(REPO, "lib", "curation", "curationQueue.server.js")).href;
const LOCK_MODULE = pathToFileURL(path.join(REPO, "lib", "curation", "curationQueueFileLock.server.js")).href;

const q = await import(QUEUE_MODULE);
const lockMod = await import(LOCK_MODULE);

const AGORA = new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function item(sku, status = "PENDING") {
  return {
    sku,
    title_en: sku,
    status,
    reason: "teste_prazo_rota",
    shopifyStatus: "DRAFT",
    metadata: { vendor: "TESTVENDOR", category: "Toys", approvedAt: null, rejectedAt: null, queuedAt: AGORA },
  };
}

function escreverFila(items) {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify({ version: 1, updatedAt: null, items }), "utf8");
  q.invalidateCurationMemoryCache();
}

/** Estado do SKU lido do disco (não da cache). */
function estadoNoDisco(sku) {
  const fila = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8"));
  return fila.items.find((i) => i.sku === sku)?.status ?? null;
}

function limparPrazos() {
  delete process.env.CURATION_QUEUE_LOCK_PRAZO_ROTA_MS;
  delete process.env.CURATION_QUEUE_LOCK_PRAZO_MS;
}

/** Conta as aquisições do lock de ficheiro feitas durante fn. */
async function contarAquisicoes(fn) {
  let total = 0;
  q.setLockAcquisitionObserverForTests(() => {
    total += 1;
  });
  try {
    await fn();
  } finally {
    q.setLockAcquisitionObserverForTests(null);
  }
  return total;
}

/** Espera até o SKU chegar ao estado, ou falha ao fim de 2 s. */
async function esperarEstado(sku, estado) {
  const limite = Date.now() + 2000;
  while (estadoNoDisco(sku) !== estado) {
    if (Date.now() > limite) throw new Error(`${sku} não chegou a ${estado} (está em ${estadoNoDisco(sku)})`);
    await sleep(20);
  }
}

const resultados = [];

async function caso(nome, fn) {
  try {
    limparPrazos();
    await fn();
    resultados.push({ nome, resultado: "passa" });
    console.log(`  passa  ${nome}`);
  } catch (err) {
    resultados.push({ nome, resultado: "falha", detalhe: err.message });
    console.log(`  falha  ${nome}\n      ${String(err.message).split("\n").join("\n      ")}`);
  } finally {
    limparPrazos();
  }
}

async function casoRotaDesisteNoPrazo() {
  process.env.CURATION_QUEUE_LOCK_PRAZO_ROTA_MS = "300";
  escreverFila([item("SKU-P1")]);
  const detentor = q.comLockDaFila(() => sleep(1500));
  await sleep(50);
  const inicio = Date.now();
  const erro = await q.comPrazoDeRota(() => q.approveProduct("SKU-P1")).then(
    () => null,
    (e) => e
  );
  const decorrido = Date.now() - inicio;
  await detentor;
  assert.ok(erro, "a rota tinha de falhar com a fila ocupada");
  assert.equal(erro.code, "CURATION_QUEUE_LOCK_TIMEOUT", `código inesperado: ${erro.code} (${erro.message})`);
  assert.match(erro.message, /\[fila\] espera esgotada/, "a mensagem tem a marca de espera esgotada");
  assert.ok(decorrido < 1000, `a rota esperou ${decorrido} ms; o prazo de rota é 300 ms`);
}

async function casoPedidoDesistidoNaoEscreve() {
  process.env.CURATION_QUEUE_LOCK_PRAZO_ROTA_MS = "300";
  escreverFila([item("SKU-P2")]);
  const detentor = q.comLockDaFila(() => sleep(800));
  await sleep(50);
  const aquisicoes = await contarAquisicoes(async () => {
    const erro = await q.comPrazoDeRota(() => q.approveProduct("SKU-P2")).then(
      () => null,
      (e) => e
    );
    assert.equal(erro?.code, "CURATION_QUEUE_LOCK_TIMEOUT", "a rota tem de desistir no prazo");
    await detentor;
    await sleep(100);
  });
  assert.equal(aquisicoes, 0, `o pedido desistido não pode tomar o lock; houve ${aquisicoes} aquisições`);
  assert.equal(estadoNoDisco("SKU-P2"), "PENDING", "o pedido desistido não pode ter aprovado o item");
  // A fila continua a andar depois da desistência: uma escrita de fundo passa.
  await q.approveProduct("SKU-P2");
  assert.equal(estadoNoDisco("SKU-P2"), "APPROVED", "a cadeia tem de continuar depois do pedido desistido");
}

async function casoFundoNaoEACortadoPeloPrazoDeRota() {
  process.env.CURATION_QUEUE_LOCK_PRAZO_ROTA_MS = "300";
  escreverFila([item("SKU-P3")]);
  const detentor = q.comLockDaFila(() => sleep(800));
  await sleep(50);
  const inicio = Date.now();
  await q.approveProduct("SKU-P3");
  const decorrido = Date.now() - inicio;
  await detentor;
  assert.ok(decorrido >= 700, `o fundo tinha de esperar pelo detentor; esperou ${decorrido} ms`);
  assert.equal(estadoNoDisco("SKU-P3"), "APPROVED", "o fundo tem de escrever depois de o detentor libertar");
}

async function casoSeccaoJaComecadaNaoEInterrompida() {
  process.env.CURATION_QUEUE_LOCK_PRAZO_ROTA_MS = "200";
  escreverFila([item("SKU-P4")]);
  const valor = await q.comPrazoDeRota(() =>
    q.comLockDaFila(async () => {
      await sleep(600);
      return "concluida";
    })
  );
  assert.equal(valor, "concluida", "a secção que começou dentro do prazo tem de concluir");
}

async function casoRotaComFilaLivreEscreve() {
  process.env.CURATION_QUEUE_LOCK_PRAZO_ROTA_MS = "300";
  escreverFila([item("SKU-P5")]);
  const resultado = await q.comPrazoDeRota(() => q.approveProduct("SKU-P5"));
  assert.equal(resultado.item.status, "APPROVED", "a rota com a fila livre tem de aprovar");
  assert.equal(estadoNoDisco("SKU-P5"), "APPROVED", "a aprovação tem de estar no disco");
}

async function casoDesisteAPesarDeTerTomadoOFicheiro() {
  // Um detentor de outro processo segura o ficheiro até 250 ms. A rota tem prazo de 200 ms e desiste
  // enquanto espera. O intervalo de tentativas do lock (até 315 ms) acaba por tomar o ficheiro depois
  // do prazo. O pedido tem de o libertar e não escrever.
  process.env.CURATION_QUEUE_LOCK_PRAZO_ROTA_MS = "200";
  escreverFila([item("SKU-P6")]);
  const titular = await lockMod.adquirirLockDoFicheiro(LOCK_PATH);
  const libertar = sleep(250).then(() => lockMod.libertarLockDoFicheiro(titular));
  const aquisicoes = await contarAquisicoes(async () => {
    const erro = await q.comPrazoDeRota(() => q.approveProduct("SKU-P6")).then(
      () => null,
      (e) => e
    );
    assert.equal(erro?.code, "CURATION_QUEUE_LOCK_TIMEOUT", "a rota tem de desistir no prazo");
    await libertar;
    await sleep(150);
  });
  assert.equal(aquisicoes, 1, `o caso tem de tomar o ficheiro depois do prazo para exercitar o caminho; houve ${aquisicoes} aquisições`);
  assert.equal(estadoNoDisco("SKU-P6"), "PENDING", "o pedido desistido não pode ter escrito");
  assert.equal(fs.existsSync(LOCK_PATH), false, "o pedido desistido tem de libertar o lock que tomou");
}

function casoPrazosPorOmissao() {
  delete process.env.CURATION_QUEUE_LOCK_PRAZO_ROTA_MS;
  delete process.env.CURATION_QUEUE_LOCK_PRAZO_MS;
  assert.equal(lockMod.prazoDaRota(), 30_000, "o prazo de rota por omissão é 30 s");
  assert.equal(lockMod.prazoDoLock(), 10 * 60_000, "o prazo de fundo por omissão é 10 min");
  assert.notEqual(lockMod.prazoDaRota(), lockMod.prazoDoLock(), "rota e fundo têm prazos separados");
}

const ROTAS_DE_ESCRITA = {
  "app/routes/api.curation.queue.$sku.approve.jsx": ["comPrazoDeRota(() => approveProduct(sku))"],
  "app/routes/api.curation.queue.$sku.reject.jsx": ["comPrazoDeRota(() => rejectProduct(sku))"],
  "app/routes/api.curation.queue.bulk.jsx": [
    "comPrazoDeRota(() => bulkTransitionPending(",
    "comPrazoDeRota(() => bulkSetMarginPct(",
  ],
  "app/routes/api.curation.queue.undo.jsx": ["comPrazoDeRota(() => restoreQueueSnapshots("],
  "app/routes/api.products.import-edits.jsx": [
    "comPrazoDeRota(() => setManualOverride(",
    "comPrazoDeRota(() => approveProduct(sku))",
    "comPrazoDeRota(() => rejectProduct(sku))",
  ],
};
const ESCRITAS_NUAS = /await (approveProduct|rejectProduct|bulkTransitionPending|bulkSetMarginPct|restoreQueueSnapshots|setManualOverride)\(/;

function casoRotasEmbrulhamEscritas() {
  for (const [rota, obrigatorios] of Object.entries(ROTAS_DE_ESCRITA)) {
    const codigo = semComentarios(fs.readFileSync(path.join(REPO, rota), "utf8"));
    for (const trecho of obrigatorios) {
      assert.ok(codigo.includes(trecho), `${rota}: falta ${trecho}`);
    }
    assert.doesNotMatch(codigo, ESCRITAS_NUAS, `${rota}: há uma escrita da fila sem comPrazoDeRota`);
  }
}

// R1: a recuperação de uma fila com caracteres de controlo espera pelo lock. Se a espera estoura,
// a leitura tem de falhar com o timeout, sem gravar a flag DB_DEGRADED e sem reescrever o ficheiro.
async function casoRecuperacaoNaoDegradaComTimeout() {
  process.env.CURATION_QUEUE_LOCK_PRAZO_ROTA_MS = "300";
  const { readDbDegraded } = await import(pathToFileURL(path.join(REPO, "lib", "health", "dbDegraded.js")).href);
  // O caráter de controlo faz o JSON falhar, e a sanitização recupera a fila: é o caminho que escreve.
  const bruto = '{"version":1,"updatedAt":null,"items":[{"sku":"SKU-R1\u0001","title_en":"Teste","status":"PENDING"}]}';
  fs.writeFileSync(QUEUE_PATH, bruto, "utf8");
  q.invalidateCurationMemoryCache();
  const detentor = q.comLockDaFila(() => sleep(1500));
  await sleep(50);
  const erro = await q.comPrazoDeRota(() => q.loadCurationQueue()).then(
    () => null,
    (e) => e
  );
  await detentor;
  assert.equal(erro?.code, "CURATION_QUEUE_LOCK_TIMEOUT", `a leitura tinha de desistir com o timeout: ${erro?.code ?? "sem erro"}`);
  assert.equal(readDbDegraded(), null, "um timeout de lock não pode gravar a flag DB_DEGRADED");
  assert.equal(fs.readFileSync(QUEUE_PATH, "utf8"), bruto, "o ficheiro não pode ser reescrito durante o timeout");
  q.invalidateCurationMemoryCache();
  const fila = await q.loadCurationQueue();
  assert.equal(fila.items.length, 1, "com o lock libertado, a leitura recupera a fila");
}

// R2: bulk e undo traduzem o timeout para 503 "fila ocupada, tenta de novo", como approve e reject.
const ROTAS_DE_503 = ["app/routes/api.curation.queue.bulk.jsx", "app/routes/api.curation.queue.undo.jsx"];

function casoRotasTraduzemTimeoutPara503() {
  for (const rota of ROTAS_DE_503) {
    const codigo = semComentarios(fs.readFileSync(path.join(REPO, rota), "utf8"));
    const catchGeral = codigo.lastIndexOf("catch (err)");
    assert.ok(catchGeral > 0, `${rota}: falta o catch (err) do topo`);
    const ramo = codigo.indexOf('err?.code === "CURATION_QUEUE_LOCK_TIMEOUT"', catchGeral);
    assert.ok(ramo > catchGeral, `${rota}: falta o ramo CURATION_QUEUE_LOCK_TIMEOUT no catch`);
    const mensagem = codigo.indexOf('"fila ocupada, tenta de novo"', ramo);
    assert.ok(mensagem > ramo, `${rota}: a mensagem de fila ocupada tem de estar no ramo do prazo`);
    const resposta = codigo.slice(mensagem, codigo.indexOf(");", mensagem));
    assert.match(resposta, /status:\s*503/, `${rota}: o ramo do prazo tem de responder 503`);
    const geral = codigo.indexOf("{ status: 500 }", catchGeral);
    assert.ok(geral > mensagem, `${rota}: a resposta genérica 500 vem depois do ramo do prazo`);
  }
}

// DBG-110: o timeout depois do override não pode dizer que nada foi escrito. A linha diz o que ficou gravado.
function casoImportEditsDizOverrideGravado() {
  const codigo = semComentarios(fs.readFileSync(path.join(REPO, "app/routes/api.products.import-edits.jsx"), "utf8"));
  const override = codigo.indexOf("setManualOverride(sku, overrides");
  const gravou = codigo.indexOf("gravou = true;");
  assert.ok(override > 0 && gravou > override, "gravou só se marca depois do override");
  assert.match(codigo, /filaOcupada && gravou/, "o motivo do timeout distingue o override já gravado");
  assert.ok(codigo.includes("o override foi gravado, a aprovação ou a rejeição não"), "a mensagem diz o que ficou gravado");
}

async function main() {
  console.log("curation-fila-prazo-rota");
  await caso("P1 rota com a fila ocupada desiste no prazo de rota, com a marca de espera esgotada", casoRotaDesisteNoPrazo);
  await caso("P2 pedido de rota desistido não escreve e não toma o lock; a cadeia continua", casoPedidoDesistidoNaoEscreve);
  await caso("P3 o fundo não é cortado pelo prazo de rota e escreve depois do detentor", casoFundoNaoEACortadoPeloPrazoDeRota);
  await caso("P4 secção que já começou dentro do prazo não é interrompida", casoSeccaoJaComecadaNaoEInterrompida);
  await caso("P5 rota com a fila livre aprova e devolve o resultado", casoRotaComFilaLivreEscreve);
  await caso("P6 pedido que desiste enquanto espera o ficheiro não escreve e liberta o lock", casoDesisteAPesarDeTerTomadoOFicheiro);
  await caso("P7 prazos por omissão: rota 30 s, fundo 10 min", casoPrazosPorOmissao);
  await caso("S1 rotas de escrita do painel usam comPrazoDeRota e não têm chamadas nuas", casoRotasEmbrulhamEscritas);
  await caso("R1 recuperação com timeout de lock não grava DB_DEGRADED e não reescreve a fila", casoRecuperacaoNaoDegradaComTimeout);
  await caso("R2 bulk e undo traduzem o timeout para 503 fila ocupada", casoRotasTraduzemTimeoutPara503);
  await caso("S2 import-edits: timeout depois do override diz que o override foi gravado (DBG-110)", casoImportEditsDizOverrideGravado);

  console.log("\nRESUMO");
  for (const r of resultados) console.log(`  ${r.resultado.padEnd(6)} ${r.nome}`);
  const nao = resultados.filter((r) => r.resultado !== "passa").length;
  if (nao) {
    console.error(`\n${nao} caso(s) não passam`);
    process.exit(1);
  }
  console.log("\ncuration-fila-prazo-rota: todos os casos passaram");
}

await main();
