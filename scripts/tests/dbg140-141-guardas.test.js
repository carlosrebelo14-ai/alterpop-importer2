#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-140 e DBG-141 (PR 5). Sem Fly nem BD reais: CURATION_DATA_DIR e PROJECT_ROOT em diretórios temporários, fork falso.
 *   (a) Script primeiro, depois o ciclo: com marcador de script vivo, startCatalogIndexingWorker recusa sem fork e sem
 *       gravar estado. Sem o marcador, o mesmo arranque faz fork. Mutação: tirar a guarda central faz fork com o script vivo.
 *   (b) DBG-141: a decisão da publicação manual recusa com indexação do catálogo e com script, e deixa passar sem nada.
 *       Mutação: a indexação deixa de contar faz o caso ficar vermelho.
 *   (c) DBG-141: o marcador de script é lido com origem, e um marcador ilegível conta como script (fail closed).
 *   (d) Rotas: a publicação manual chama a decisão antes da reserva; o ciclo recusa com script antes do IIFE; o painel
 *       recusa antes de arrancar. Mutação em cada rota: tirar a chamada faz o caso ficar vermelho.
 *   (e) DBG-140: o reset toma a reserva da publicação e a rota devolve 409 enquanto ela está ocupada. A reserva sai no
 *       fim do reset. Mutação: tirar a reserva do reset ou a libertação no background faz o caso ficar vermelho.
 * Uso: node scripts/tests/dbg140-141-guardas.test.js
 */
import "./_isolate-curation.js";

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "dbg140-141-"));
process.on("exit", () => fs.rmSync(raiz, { recursive: true, force: true }));

// Antes de importar os módulos: o config lê PROJECT_ROOT ao carregar.
process.env.PROJECT_ROOT = raiz;

const modulo = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);
const indexacao = await modulo("lib/importer/catalog/indexingStream.server.js");
const atividade = await modulo("lib/curation/atividadeApp.js");
const dados = await modulo("lib/curation/dataDir.js");
const publicacao = await modulo("lib/importer/shopify/publicacaoEmCurso.js");

const SHOP = "loja-guardas.myshopify.com";
const DIR_INDEX = path.join(raiz, "data", "catalog-index");
const ficheiroDoEstado = (shop) => path.join(DIR_INDEX, `${shop.replace(/\//g, "_")}-rebuild-status.json`);

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

/** Fork falso: um EventEmitter com a forma que o arranque usa. */
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 4444;
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

/** Troca única: o trecho tem de existir exatamente uma vez, senão a mutação não diz o que pensa. */
function trocaUnica(texto, antigo, novo) {
  const vezes = texto.split(antigo).length - 1;
  if (vezes !== 1) throw new Error(`o trecho tem de existir uma vez (existe ${vezes}x): ${antigo.slice(0, 70)}`);
  return texto.replace(antigo, novo);
}

/** Cópia de um módulo com uma troca, na mesma pasta (os imports relativos continuam válidos). Quem chama apaga. */
function mutanteDo(relativo, nome, transformar) {
  const origem = path.join(RAIZ, relativo);
  const novo = transformar(fs.readFileSync(origem, "utf8"));
  const destino = path.join(path.dirname(origem), `.mutante-${nome}-${process.pid}.mjs`);
  fs.writeFileSync(destino, novo);
  return destino;
}

/** Marcadores de indexação na pasta da curadoria. Limpa-os: um teste não herda sobras de outro. */
function marcadoresDeIndexacao() {
  const dir = dados.resolveCurationDataDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.startsWith("catalog-busy-indexacao-"));
}
function limparMarcadores() {
  const dir = dados.resolveCurationDataDir();
  for (const nome of marcadoresDeIndexacao()) fs.rmSync(path.join(dir, nome), { force: true });
}

/** Lê o texto de um ficheiro da app, para as verificações de rota. */
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), "utf8");

/** Posição de uma âncora, que tem de existir. indexOf devolve -1 em silêncio, e isso não pode passar. */
function posicao(texto, ancora, ficheiro) {
  const i = texto.indexOf(ancora);
  assert.ok(i >= 0, `${ficheiro}: âncora em falta: ${ancora.slice(0, 80)}`);
  return i;
}

// --- Verificações de rota (texto). Cada uma lança se a guarda não estiver no sítio certo. ---

const ROTA_PUBLICACAO = "app/routes/api.shopify-sync.jsx";
function verificarRotaPublicacaoManual(texto) {
  const decisao = posicao(texto, "const motivoIndexacao = motivoDeRecusaDaPublicacaoManual({", ROTA_PUBLICACAO);
  const recusa = posicao(texto, "if (motivoIndexacao) {", ROTA_PUBLICACAO);
  const reserva = posicao(texto, "const reserva = tentarReservarPublicacao();", ROTA_PUBLICACAO);
  assert.ok(decisao < recusa && recusa < reserva, "a decisão de indexação tem de ser tomada e aplicada antes da reserva");
}

const ROTA_CICLO = "app/routes/api.trigger-sync.jsx";
function verificarRotaCiclo(texto) {
  const decisao = posicao(texto, "const recusaScript = motivoDeRecusaPorScript(scriptDeIndexacaoEmCurso());", ROTA_CICLO);
  const iife = posicao(texto, "void (async () => {", ROTA_CICLO);
  assert.ok(decisao < iife, "o ciclo tem de recusar com script antes de arrancar o IIFE");
  const bloco = texto.slice(decisao, iife);
  assert.match(bloco, /status: 409/, "a recusa do ciclo tem de responder 409");
  assert.match(bloco, /reason: "script_indexing_running"/, "a recusa do ciclo tem de dizer a causa");
}

const ROTA_PAINEL = "app/routes/app._index.jsx";
function verificarPainel(texto) {
  const recusa = posicao(texto, "const recusaScript = motivoDeRecusaPorScript(scriptDeIndexacaoEmCurso());", ROTA_PAINEL);
  const retoma = posicao(texto, "startCatalogRebuildInBackground(session.shop", ROTA_PAINEL);
  const purga = posicao(texto, "startCatalogCleanupInBackground(session.shop", ROTA_PAINEL);
  assert.ok(recusa < retoma && recusa < purga, "o painel tem de recusar antes de arrancar a reindexação ou a purga");
}

const ROTA_RESET = "app/routes/api.shopify-reset.jsx";
function verificarRotaReset(texto) {
  const reserva = posicao(texto, "const reserva = tentarReservarPublicacao();", ROTA_RESET);
  const arranque = posicao(texto, "startShopifyCatalogResetInBackground(session, { reserva });", ROTA_RESET);
  assert.ok(reserva < arranque, "o reset tem de tomar a reserva antes de arrancar o job");
  const libertacoes = texto.split("reserva.libertar();").length - 1;
  assert.ok(libertacoes >= 2, "os caminhos de erro antes do job têm de libertar a reserva");
}

const RESET_BG = "lib/importer/shopify/shopifyReset.server.js";
function verificarLibertacaoDoReset(texto) {
  const inicio = posicao(texto, "export function startShopifyCatalogResetInBackground(session, opts = {}) {", RESET_BG);
  const fim = posicao(texto.slice(inicio), "\n}", RESET_BG) + inicio;
  assert.match(texto.slice(inicio, fim), /\.finally\(\(\) => opts\.reserva\?\.libertar\(\)\);/, "o reset tem de libertar a reserva no fim");
}

console.log("dbg140-141 — publicação manual, ciclo, painel e reset com script de reindexação e reserva");

await caso("(a) script primeiro, depois o ciclo: com script vivo não há fork nem estado; sem script, o ciclo arranca", async () => {
  limparMarcadores();
  const shop = SHOP;
  let forks = 0;
  const filhos = [];
  indexacao.definirForkParaTestes(() => {
    forks += 1;
    const c = new FakeChild();
    filhos.push(c);
    return c;
  });
  try {
    const marca = atividade.marcarAtividadeApp({ tipo: "indexacao", pid: process.pid, origem: "script" });
    let recusado;
    try {
      recusado = await indexacao.startCatalogIndexingWorker(shop, {}, { causa: "ciclo" });
    } finally {
      marca();
    }
    assert.equal(recusado, null, "o ciclo tem de recusar com script vivo");
    assert.equal(forks, 0, "com script vivo não pode haver fork");
    assert.equal(fs.existsSync(ficheiroDoEstado(shop)), false, "a recusa não grava estado: o estado é do script");

    const arrancou = await indexacao.startCatalogIndexingWorker(shop, {}, { causa: "ciclo" });
    assert.notEqual(arrancou, null, "sem script, o ciclo arranca");
    assert.equal(forks, 1);
    filhos[0].emit("exit", 0, null);
  } finally {
    indexacao.definirForkParaTestes(null);
    limparMarcadores();
  }
});

await caso("mutação: sem a guarda central, o ciclo faz fork com o script vivo (o caso (a) tem de ficar vermelho)", async () => {
  const m = mutanteDo("lib/importer/catalog/indexingStream.server.js", "sem-guarda-central", (t) =>
    trocaUnica(t, "const recusaScript = motivoDeRecusaPorScript(scriptDeIndexacaoEmCurso());", "const recusaScript = null;")
  );
  limparMarcadores();
  let forks = 0;
  const filhos = [];
  const mod = await import(pathToFileURL(m).href);
  mod.definirForkParaTestes(() => {
    forks += 1;
    const c = new FakeChild();
    filhos.push(c);
    return c;
  });
  try {
    const marca = atividade.marcarAtividadeApp({ tipo: "indexacao", pid: process.pid, origem: "script" });
    try {
      await mod.startCatalogIndexingWorker("loja-mutante.myshopify.com", {}, { causa: "ciclo" });
    } finally {
      marca();
    }
    assert.notEqual(forks, 0, "a mutação tem de fazer fork com o script vivo, e o caso (a) tem de apanhar isso");
  } finally {
    mod.definirForkParaTestes(null);
    for (const c of filhos) c.emit("exit", 0, null);
    limparMarcadores();
    fs.rmSync(m, { force: true });
  }
});

await caso("(b) DBG-141: a decisão da publicação manual recusa com indexação e com script, e deixa passar sem nada", () => {
  const { motivoDeRecusaDaPublicacaoManual } = atividade;
  const script = { tipo: "script", pid: 1, motivo: "pid 1, desde 2026-10-17T20:00:00.000Z" };
  assert.match(motivoDeRecusaDaPublicacaoManual({ indexacaoEmCurso: true, atividadeScript: null }), /indexação do catálogo/);
  assert.match(motivoDeRecusaDaPublicacaoManual({ indexacaoEmCurso: false, atividadeScript: script }), /Reindexação por script/);
  assert.equal(motivoDeRecusaDaPublicacaoManual({ indexacaoEmCurso: false, atividadeScript: null }), null);
});

await caso("mutação: a decisão deixa de contar a indexação e o caso (b) tem de ficar vermelho", async () => {
  const m = mutanteDo("lib/curation/atividadeApp.js", "indexacao-nao-conta", (t) =>
    trocaUnica(t, "  if (indexacaoEmCurso) {\n    return \"Aguarda que a indexação do catálogo termine antes de publicar.\";", "  if (false) {\n    return \"Aguarda que a indexação do catálogo termine antes de publicar.\";")
  );
  try {
    const mod = await import(pathToFileURL(m).href);
    const motivo = mod.motivoDeRecusaDaPublicacaoManual({ indexacaoEmCurso: true, atividadeScript: null });
    assert.equal(motivo, null, "a mutação tem de deixar passar com indexação, e o caso (b) tem de apanhar isso");
    assert.throws(() => assert.match(String(motivo), /indexação do catálogo/));
  } finally {
    fs.rmSync(m, { force: true });
  }
});

await caso("(c) marcador de script lido com origem; marcador da app não conta; marcador ilegível conta (fail closed)", () => {
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const marca = atividade.marcarAtividadeApp({ tipo: "indexacao", pid: process.pid });
  try {
    assert.equal(atividade.scriptDeIndexacaoEmCurso(), null, "um marcador da app não é script");
  } finally {
    marca();
  }
  const marcaScript = atividade.marcarAtividadeApp({ tipo: "indexacao", pid: process.pid, origem: "script" });
  try {
    const script = atividade.scriptDeIndexacaoEmCurso();
    assert.equal(script?.tipo, "script");
    assert.equal(script?.pid, process.pid);
  } finally {
    marcaScript();
  }
  fs.writeFileSync(path.join(dir, "catalog-busy-indexacao-1-ilegivel.json"), "{ truncado", "utf8");
  try {
    assert.equal(atividade.scriptDeIndexacaoEmCurso()?.tipo, "desconhecida", "marcador ilegível tem de recusar");
  } finally {
    fs.rmSync(path.join(dir, "catalog-busy-indexacao-1-ilegivel.json"), { force: true });
  }
});

await caso("(d) rota da publicação manual: a decisão de indexação vem antes da reserva e aplica-se", () => {
  verificarRotaPublicacaoManual(ler(ROTA_PUBLICACAO));
});

await caso("mutação: a rota da publicação manual deixa de recusar com indexação (o caso (d) tem de ficar vermelho)", () => {
  const texto = ler(ROTA_PUBLICACAO);
  assert.throws(() => verificarRotaPublicacaoManual(trocaUnica(texto, "if (motivoIndexacao) {", "if (false) {")), /âncora|antes da reserva/);
});

await caso("(d) rota do ciclo: recusa com script antes do IIFE, com 409 e causa", () => {
  verificarRotaCiclo(ler(ROTA_CICLO));
});

await caso("mutação: o ciclo deixa de recusar com script (o caso (d) do ciclo tem de ficar vermelho)", () => {
  const texto = ler(ROTA_CICLO);
  assert.throws(() =>
    verificarRotaCiclo(trocaUnica(texto, "const recusaScript = motivoDeRecusaPorScript(scriptDeIndexacaoEmCurso());", "const recusaScript = null;"))
  );
});

await caso("(d) painel: recusa com script antes de arrancar a reindexação ou a purga", () => {
  verificarPainel(ler(ROTA_PAINEL));
});

await caso("mutação: o painel deixa de recusar com script (o caso (d) do painel tem de ficar vermelho)", () => {
  const texto = ler(ROTA_PAINEL);
  assert.throws(() =>
    verificarPainel(trocaUnica(texto, "const recusaScript = motivoDeRecusaPorScript(scriptDeIndexacaoEmCurso());", "const recusaScript = null;"))
  );
});

await caso("(e) DBG-140: enquanto o ciclo tem a reserva, o reset não a toma; a reserva volta quando sai", () => {
  const reservaDoCiclo = publicacao.tentarReservarPublicacao();
  assert.notEqual(reservaDoCiclo, null, "o ciclo tem de conseguir a reserva");
  assert.equal(publicacao.tentarReservarPublicacao(), null, "o reset não pode tomar a reserva do ciclo: a rota devolve 409");
  reservaDoCiclo.libertar();
  const reservaDoReset = publicacao.tentarReservarPublicacao();
  assert.notEqual(reservaDoReset, null, "com a reserva livre, o reset toma-a");
  reservaDoReset.libertar();
});

await caso("(e) rota do reset: toma a reserva antes do job e liberta-a nos caminhos de erro", () => {
  verificarRotaReset(ler(ROTA_RESET));
});

await caso("(e) reset em background: a reserva sai no fim do job", () => {
  verificarLibertacaoDoReset(ler(RESET_BG));
});

await caso("mutação: o reset deixa de tomar a reserva (o caso (e) da rota tem de ficar vermelho)", () => {
  const texto = ler(ROTA_RESET);
  assert.throws(() =>
    verificarRotaReset(trocaUnica(texto, "const reserva = tentarReservarPublicacao();", "const reserva = { libertar() {} };"))
  );
});

await caso("mutação: o reset deixa de libertar a reserva no fim (o caso (e) do background tem de ficar vermelho)", () => {
  const texto = ler(RESET_BG);
  assert.throws(() =>
    verificarLibertacaoDoReset(trocaUnica(texto, "      .finally(() => opts.reserva?.libertar());", ""))
  );
});

if (falhas) {
  console.error(`\ndbg140-141-guardas: ${falhas} verificação(ões) falharam`);
  process.exit(1);
}
console.log("\ndbg140-141-guardas: todos os casos passaram");
