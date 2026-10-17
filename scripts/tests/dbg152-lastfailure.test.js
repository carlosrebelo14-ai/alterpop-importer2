#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-152 (PR 3). Última falha da indexação, `lastFailure {at, causa, error}`, no ficheiro de estado.
 * Sem Fly nem BD reais: PROJECT_ROOT em diretório temporário, fork falso, e cópias de módulos com um trecho trocado.
 *   (a) Uma falha do worker grava lastFailure (data, causa, texto no ficheiro). O texto não sai para os logs.
 *       Mutação: sem o registo, o teste fica vermelho. Mutação: o log volta a levar o texto, fica vermelho.
 *   (b) O completed mantém o lastFailure. Mutação: o completed apaga-o, fica vermelho.
 *   (c) Uma nova falha substitui o lastFailure. Mutação: a falha nova mantém a antiga, fica vermelho.
 *   (d) Saída do worker com código classificada como worker_saiu, e por sinal como worker_morto. Inclui a saída
 *       antes do try e antes do done, que passam por este caminho. Mutação: causa genérica, fica vermelho.
 *   (e) indexing_status mostra falha_em, falha_causa, falha_classe e totalRejected, nunca o texto. Classes iguais às
 *       do módulo partilhado. Mutações: texto impresso, totalRejected removido, ficam vermelhas.
 *   (f) O V16 descreve a causa, a data e a classe, nunca o texto. Mutações no V16 e no módulo, ficam vermelhas.
 * Uso: node scripts/tests/dbg152-lastfailure.test.js
 */
import "./_isolate-curation.js";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "dbg152-"));
process.on("exit", () => fs.rmSync(raiz, { recursive: true, force: true }));

// Antes de importar os módulos: o config lê PROJECT_ROOT ao carregar.
process.env.PROJECT_ROOT = raiz;

const modulo = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);
const estado = await modulo("lib/importer/catalog/catalogRebuildStatus.server.js");
const indexacao = await modulo("lib/importer/catalog/indexingStream.server.js");
const falha = await modulo("lib/importer/catalog/falhaIndexacao.js");

const DIR_INDEX = path.join(raiz, "data", "catalog-index");
const ficheiroDoEstado = (shop) => path.join(DIR_INDEX, `${shop.replace(/\//g, "_")}-rebuild-status.json`);
const lerEstado = (shop) => JSON.parse(fs.readFileSync(ficheiroDoEstado(shop), "utf8"));

/** Fork falso: um EventEmitter com a forma que o arranque usa. */
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 4242;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
    this.exitCode = null;
    this.signalCode = null;
  }
  kill() {
    this.killed = true;
    return true;
  }
}

async function esperarAte(condicao, ms = 5000) {
  const inicio = Date.now();
  while (!condicao()) {
    if (Date.now() - inicio > ms) throw new Error("tempo esgotado à espera de um evento");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Uma corrida com fork falso. `depois(filho)` emite a mensagem ou a saída do worker. Devolve os eventos e tudo o
 * que foi para console (logs), para a verificação do texto do erro.
 */
async function corrida(ind, shop, depois) {
  const filhos = [];
  ind.definirForkParaTestes(() => {
    const c = new FakeChild();
    filhos.push(c);
    return c;
  });
  const eventos = [];
  const parar = ind.subscribeIndexingEvents(shop, (e) => eventos.push(e));
  const saida = [];
  const log = console.log;
  const erro = console.error;
  console.log = (...a) => saida.push(a.map(String).join(" "));
  console.error = (...a) => saida.push(a.map(String).join(" "));
  try {
    await ind.startCatalogIndexingWorker(shop, {}, { causa: "painel" });
    depois(filhos[0]);
    await esperarAte(() => eventos.some((e) => e.type === "closed"));
    return { eventos, saida: saida.join("\n") };
  } finally {
    console.log = log;
    console.error = erro;
    if (typeof parar === "function") parar();
    ind.definirForkParaTestes(null);
  }
}

/** Cópia de um módulo com trechos trocados, no mesmo diretório (os imports relativos continuam válidos). */
function mutanteVarios(relativo, nome, pares) {
  const origem = path.join(RAIZ, relativo);
  let texto = fs.readFileSync(origem, "utf8");
  for (const [antigo, novo] of pares) {
    if (texto.split(antigo).length - 1 !== 1) throw new Error(`mutação ${nome}: o trecho tem de existir uma vez`);
    texto = texto.replace(antigo, () => novo);
  }
  const destino = path.join(path.dirname(origem), `.mutante-${nome}-${process.pid}.mjs`);
  fs.writeFileSync(destino, texto);
  return { caminho: destino, apagar: () => fs.rmSync(destino, { force: true }) };
}

const SCRIPT = path.join(RAIZ, "scripts", "maintenance", "indexing-status.mjs");
/** Corre o indexing-status com um ficheiro de estado de teste. Devolve a saída. */
function correrIndexingStatus(shop, estadoDoFicheiro) {
  const dados = fs.mkdtempSync(path.join(raiz, "is-"));
  fs.mkdirSync(path.join(dados, "catalog-index"), { recursive: true });
  fs.writeFileSync(path.join(dados, "catalog-index", `${shop}-rebuild-status.json`), JSON.stringify(estadoDoFicheiro));
  const r = spawnSync(process.execPath, [SCRIPT, "--shop", shop, "--data-dir", dados], { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
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

const SEGREDO = "SEGREDO-152-texto-do-erro";

// ---------- (a) falha grava lastFailure; texto no ficheiro, nunca nos logs ----------
console.log("(a) falha do worker grava lastFailure; o texto não sai para os logs");
/** Verificação (a). Devolve o que ficou no disco e nos logs, para as mutações. */
async function verificarFalhaGravada(ind, shop) {
  const { saida } = await corrida(ind, shop, (c) => c.emit("message", { type: "error", message: `${SEGREDO} erro do worker` }));
  const lido = lerEstado(shop);
  assert.equal(lido.lastFailure?.causa, "erro_worker", "a causa tem de ficar no lastFailure");
  assert.equal(lido.lastFailure?.error, `${SEGREDO} erro do worker`, "o texto fica no ficheiro");
  assert.match(lido.lastFailure?.at ?? "", /^\d{4}-\d{2}-\d{2}T/, "a data tem de ser ISO");
  assert.equal(saida.includes(SEGREDO), false, "o texto do erro não pode sair para os logs");
}
await caso("falha do worker grava lastFailure {at, causa, error} e o texto não sai para os logs", () =>
  verificarFalhaGravada(indexacao, "loja-152-a.myshopify.com"));
await caso("mutação: sem o registo, a falha não grava lastFailure (o caso acima tem de ficar vermelho)", async () => {
  const m = mutanteVarios("lib/importer/catalog/indexingStream.server.js", "sem-registo", [
    ["      lastFailure: registoDaFalha(causaFalha, errorMessage),\n", ""],
  ]);
  try {
    const mutado = await modulo(path.relative(RAIZ, m.caminho));
    await assert.rejects(verificarFalhaGravada(mutado, "loja-152-a.mut.myshopify.com"));
  } finally {
    m.apagar();
  }
});
await caso("mutação: o log volta a levar o texto do erro (o caso acima tem de ficar vermelho)", async () => {
  const m = mutanteVarios("lib/importer/catalog/indexingStream.server.js", "log-com-texto", [
    [
      "    console.error(`[indexingStream] falha da indexação para ${shop}: causa=${causaFalha}`);",
      "    console.error(`[indexingStream] Error in worker process for ${shop}:`, errorMessage);",
    ],
  ]);
  try {
    const mutado = await modulo(path.relative(RAIZ, m.caminho));
    await assert.rejects(verificarFalhaGravada(mutado, "loja-152-a2.mut.myshopify.com"));
  } finally {
    m.apagar();
  }
});

// ---------- (b) o completed mantém o lastFailure ----------
console.log("(b) completed mantém o lastFailure");
/** Verificação (b): uma falha, depois uma corrida concluída. O lastFailure tem de ficar igual. */
async function verificarCompletedMantem(ind, shop) {
  await corrida(ind, shop, (c) => c.emit("message", { type: "error", message: "primeira falha" }));
  const antes = lerEstado(shop).lastFailure;
  await corrida(ind, shop, (c) => c.emit("message", { type: "done", indexed: 3, scanned: 3 }));
  const depois = lerEstado(shop);
  assert.equal(depois.state, "completed", "a corrida nova tem de ficar concluída");
  assert.deepEqual(depois.lastFailure, antes, "o completed tem de manter o lastFailure");
}
await caso("uma corrida concluída mantém o lastFailure da falha anterior", () =>
  verificarCompletedMantem(indexacao, "loja-152-b.myshopify.com"));
await caso("mutação: o completed apaga o lastFailure (o caso acima tem de ficar vermelho)", async () => {
  const m = mutanteVarios("lib/importer/catalog/indexingStream.server.js", "completed-apaga", [
    ['      state: "completed",\n', '      state: "completed",\n      lastFailure: null,\n'],
  ]);
  try {
    const mutado = await modulo(path.relative(RAIZ, m.caminho));
    await assert.rejects(verificarCompletedMantem(mutado, "loja-152-b.mut.myshopify.com"));
  } finally {
    m.apagar();
  }
});

// ---------- (c) uma nova falha substitui o lastFailure ----------
console.log("(c) uma nova falha substitui o lastFailure");
/** Verificação (c): duas falhas seguidas. O disco tem de ficar com a segunda. */
async function verificarNovaFalhaSubstitui(ind, shop) {
  await corrida(ind, shop, (c) => c.emit("message", { type: "error", message: "primeira falha" }));
  await corrida(ind, shop, (c) => c.emit("message", { type: "error", message: "segunda falha" }));
  const lido = lerEstado(shop);
  assert.equal(lido.lastFailure?.error, "segunda falha", "a falha nova tem de substituir a antiga");
}
await caso("uma falha nova substitui o lastFailure da anterior", () =>
  verificarNovaFalhaSubstitui(indexacao, "loja-152-c.myshopify.com"));
await caso("mutação: a falha nova mantém a antiga (o caso acima tem de ficar vermelho)", async () => {
  const m = mutanteVarios("lib/importer/catalog/indexingStream.server.js", "mantem-antiga", [
    ["      lastFailure: registoDaFalha(causaFalha, errorMessage),\n", "      lastFailure: emDisco.lastFailure || registoDaFalha(causaFalha, errorMessage),\n"],
  ]);
  try {
    const mutado = await modulo(path.relative(RAIZ, m.caminho));
    await assert.rejects(verificarNovaFalhaSubstitui(mutado, "loja-152-c.mut.myshopify.com"));
  } finally {
    m.apagar();
  }
});

// ---------- (d) saída do worker classificada ----------
console.log("(d) saída do worker: worker_saiu e worker_morto");
/** Verificação (d): saída com código sem mensagem final (inclui saída antes do try e antes do done). */
async function verificarSaidaComCodigo(ind, shop) {
  await corrida(ind, shop, (c) => c.emit("exit", 1, null));
  const lido = lerEstado(shop);
  assert.equal(lido.lastFailure?.causa, "worker_saiu", "saída com código tem de ser worker_saiu");
  assert.equal(lido.lastFailure?.error, "worker process exited with code 1");
}
await caso("saída do worker com código 1 sem mensagem final é worker_saiu", () =>
  verificarSaidaComCodigo(indexacao, "loja-152-d.myshopify.com"));
await caso("saída do worker por sinal é worker_morto", async () => {
  await corrida(indexacao, "loja-152-d2.myshopify.com", (c) => c.emit("exit", null, "SIGKILL"));
  const lido = lerEstado("loja-152-d2.myshopify.com");
  assert.equal(lido.lastFailure?.causa, "worker_morto");
});
await caso("mutação: a saída com código perde a classe (o caso acima tem de ficar vermelho)", async () => {
  const m = mutanteVarios("lib/importer/catalog/indexingStream.server.js", "causa-generica", [
    ['finishFailed(errorMessage, signal ? "worker_morto" : "worker_saiu")', 'finishFailed(errorMessage, "erro_worker")'],
  ]);
  try {
    const mutado = await modulo(path.relative(RAIZ, m.caminho));
    await assert.rejects(verificarSaidaComCodigo(mutado, "loja-152-d.mut.myshopify.com"));
  } finally {
    m.apagar();
  }
});

// ---------- (e) indexing_status ----------
console.log("(e) indexing_status: causa, data, classe e totalRejected; nunca o texto");
const SHOP_E = "loja-152-e.myshopify.com";
const ESTADO_E = {
  state: "failed",
  startedAt: "2026-10-17T17:00:00.000Z",
  finishedAt: "2026-10-17T18:00:00.000Z",
  totalRows: 26087,
  checkpointScanned: null,
  totalRejected: 140,
  error: "worker process exited with code 1",
  lastFailure: { at: "2026-10-17T18:00:00.000Z", causa: "worker_saiu", error: "worker process exited with code 1" },
};
await caso("indexing_status mostra falha_em, falha_causa, falha_classe e totalRejected", () => {
  const r = correrIndexingStatus(SHOP_E, ESTADO_E);
  assert.equal(r.status, 0, r.stderr);
  const linha = r.stdout.trim();
  assert.match(linha, /\btotalRejected=140\b/);
  assert.match(linha, /\bfalha_em=2026-10-17T18:00:00\.000Z\b/);
  assert.match(linha, /\bfalha_causa=worker_saiu\b/);
  assert.match(linha, /\bfalha_classe=worker_saiu\b/);
});
await caso("indexing_status não mostra o texto de error, nem o do lastFailure", () => {
  const r = correrIndexingStatus(SHOP_E, {
    ...ESTADO_E,
    error: `${SEGREDO} erro`,
    lastFailure: { at: "2026-10-17T18:00:00.000Z", causa: "erro_worker", error: `${SEGREDO} erro` },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.includes(SEGREDO), false, "o texto não pode sair no indexing_status");
  assert.equal(r.stderr.includes(SEGREDO), false);
});
await caso("sem lastFailure, os campos de falha dizem nenhuma", () => {
  const r = correrIndexingStatus(SHOP_E, { state: "completed", totalRows: 5 });
  assert.match(r.stdout, /\bfalha_em=nenhuma falha_causa=nenhuma falha_classe=nenhuma\b/);
});
await caso("as classes do indexing_status são as do módulo partilhado, para os mesmos textos", () => {
  const amostras = [
    "[fila] espera esgotada: x",
    "worker process exited with code 1",
    "worker process killed (SIGKILL)",
    "A indexação não arrancou. Nada foi indexado.",
    "estado de indexação ilegível: x",
    "outra coisa",
    "",
  ];
  for (const erro of amostras) {
    const r = correrIndexingStatus("loja-152-classes.myshopify.com", { state: "failed", error: erro });
    const classe = r.stdout.match(/\berro=(\S+)/)?.[1];
    assert.equal(classe, falha.classeDoErro(erro), `texto ${JSON.stringify(erro)}`);
  }
});
await caso("mutação: o indexing_status imprime o texto do lastFailure (o caso acima tem de ficar vermelho)", async () => {
  const m = mutanteVarios("scripts/maintenance/indexing-status.mjs", "imprime-texto", [
    ["    `falha_classe=${campos.lastFailure && typeof", "    `falha_classe=${campos.lastFailure?.error ?? \"\"} ${campos.lastFailure && typeof"],
  ]);
  try {
    const r = spawnSync(process.execPath, [m.caminho, "--shop", SHOP_E, "--data-dir", (() => {
      const dados = fs.mkdtempSync(path.join(raiz, "is-mut-"));
      fs.mkdirSync(path.join(dados, "catalog-index"), { recursive: true });
      fs.writeFileSync(path.join(dados, "catalog-index", `${SHOP_E}-rebuild-status.json`), JSON.stringify({ ...ESTADO_E, lastFailure: { ...ESTADO_E.lastFailure, error: `${SEGREDO} erro` } }));
      return dados;
    })()], { encoding: "utf8" });
    assert.throws(() => assert.equal(r.stdout.includes(SEGREDO), false));
  } finally {
    m.apagar();
  }
});
await caso("mutação: sem totalRejected, o indexing_status não mostra os 140 (o caso acima tem de ficar vermelho)", async () => {
  const m = mutanteVarios("scripts/maintenance/indexing-status.mjs", "sem-total-rejected", [
    ["    `totalRejected=${token(campos.totalRejected", "    `totalRejeitados=${token(campos.totalRejected"],
  ]);
  try {
    const dados = fs.mkdtempSync(path.join(raiz, "is-tr-"));
    fs.mkdirSync(path.join(dados, "catalog-index"), { recursive: true });
    fs.writeFileSync(path.join(dados, "catalog-index", `${SHOP_E}-rebuild-status.json`), JSON.stringify(ESTADO_E));
    const r = spawnSync(process.execPath, [m.caminho, "--shop", SHOP_E, "--data-dir", dados], { encoding: "utf8" });
    assert.throws(() => assert.match(r.stdout, /\btotalRejected=140\b/));
  } finally {
    m.apagar();
  }
});

// ---------- (f) V16 ----------
console.log("(f) V16 descreve a causa, a data e a classe; nunca o texto");
const V16_FONTE = fs.readFileSync(path.join(RAIZ, "scripts", "catalog", "pre-pilot-verify.js"), "utf8");
/** Verificação (f), sobre a fonte do V16: nenhuma mensagem usa rebuildStatus.error, e as duas usam a descrição. */
function verificarV16(fonte) {
  assert.doesNotMatch(fonte, /rebuildStatus\.error/, "o V16 não pode mostrar o texto do error");
  assert.match(fonte, /descreverUltimaFalha\(rebuildStatus\)/, "o V16 tem de usar a descrição partilhada");
}
await caso("a descrição da falha tem causa, data e classe, sem o texto", () => {
  const texto = falha.descreverUltimaFalha({
    lastFailure: { at: "2026-10-17T18:00:00.000Z", causa: "worker_saiu", error: `${SEGREDO} erro` },
  });
  assert.match(texto, /causa worker_saiu, em 2026-10-17T18:00:00\.000Z, classe outra/);
  assert.equal(texto.includes(SEGREDO), false);
  assert.equal(falha.descreverUltimaFalha({ state: "failed" }), "erro desconhecido");
});
await caso("o V16 usa a descrição partilhada e não mostra rebuildStatus.error", () => verificarV16(V16_FONTE));
await caso("mutação: o V16 volta a mostrar rebuildStatus.error (o caso acima tem de ficar vermelho)", () => {
  const mutado = V16_FONTE.replace("descreverUltimaFalha(rebuildStatus)", '(rebuildStatus.error || "erro desconhecido")');
  assert.throws(() => verificarV16(mutado));
});
await caso("registoDaFalha normaliza a causa para a lista fechada", () => {
  assert.equal(falha.registoDaFalha("causa-inventada", "x", "2026-10-17T18:00:00.000Z").causa, "erro_worker");
  assert.equal(falha.registoDaFalha("marcador", "x", "2026-10-17T18:00:00.000Z").causa, "marcador");
});
await caso("mutação: o módulo partilhado devolve o texto do erro (o caso acima tem de ficar vermelho)", async () => {
  const m = mutanteVarios("lib/importer/catalog/falhaIndexacao.js", "texto-no-v16", [
    ["  return `causa ${causa}, em ${em}, classe ${classeDoErro(falha.error)}`;", "  return falha.error;"],
  ]);
  try {
    const mutado = await modulo(path.relative(RAIZ, m.caminho));
    const texto = mutado.descreverUltimaFalha({ lastFailure: { at: "2026-10-17T18:00:00.000Z", causa: "worker_saiu", error: `${SEGREDO} erro` } });
    assert.throws(() => assert.equal(texto.includes(SEGREDO), false));
  } finally {
    m.apagar();
  }
});

if (falhas) {
  console.error(`\ndbg152-lastfailure: ${falhas} verificação(ões) falharam`);
  process.exit(1);
}
console.log("\ndbg152-lastfailure: todos os casos passaram");
