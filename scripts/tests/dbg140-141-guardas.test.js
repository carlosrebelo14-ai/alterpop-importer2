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
 *   (f) a corrida de um script leva origem script, e a da app leva origem app. Mutação: origem fixa faz o caso ficar vermelho.
 *   (g) com uma publicação ou um reset com a reserva tomada, a indexação não arranca. Mutação: sem a recusa, há fork.
 *   (h) a publicação manual confirma a indexação depois de tomar a reserva. Mutação: sem a confirmação, o caso fica vermelho.
 *   (i) o ciclo para quando a indexação não arranca. Mutação: sem o aborto, o ciclo segue e o caso fica vermelho.
 *   (j) um marcador ilegível conta enquanto é recente, e deixa de contar ao fim de 10 min. Mutação: sem o prazo, fica bloqueado.
 * Uso: node scripts/tests/dbg140-141-guardas.test.js
 */
import "./_isolate-curation.js";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import http from "node:http";
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
// Loja própria da origem (f): um filho de outro caso ainda em activeChildren faria o arranque devolver-lhe a corrida.
const SHOP_ORIGEM = "loja-origem-script.myshopify.com";
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

/**
 * Processo vivo que não é este. A guarda ignora as marcas do próprio processo (a purga marca-se e arranca o worker),
 * por isso um script de teste tem de ter outro pid para contar como script em curso. Quem chama mata-o.
 */
function processoAlheio() {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
}

async function esperarAte(condicao, ms = 5000) {
  const inicio = Date.now();
  while (!condicao()) {
    if (Date.now() - inicio > ms) throw new Error("tempo esgotado à espera de um evento");
    await new Promise((r) => setTimeout(r, 10));
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
/** Apaga todos os marcadores de atividade (indexação e publicação), para um caso não herdar sobras de outro. */
function limparMarcadores() {
  const dir = dados.resolveCurationDataDir();
  if (!fs.existsSync(dir)) return;
  for (const nome of fs.readdirSync(dir).filter((n) => n.startsWith("catalog-busy-"))) fs.rmSync(path.join(dir, nome), { force: true });
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
  const reserva = posicao(texto, "reserva = tentarReservarPublicacao({", ROTA_PUBLICACAO);
  assert.ok(decisao < recusa && recusa < reserva, "a decisão de indexação tem de ser tomada e aplicada antes da reserva");
  posicao(texto, 'tentarReservarPublicacao({ marcar: () => marcarAtividadeApp({ tipo: "publicacao" }) })', ROTA_PUBLICACAO);
  assert.match(
    texto.slice(recusa, reserva),
    /return Response\.json\(\{ ok: false, error: motivoIndexacao \}, \{ status: 409 \}\);/,
    "a recusa tem de ser um return com 409, não uma chamada solta"
  );
}

/** A decisão é repetida depois da reserva, com return 409 e libertação da reserva. */
function verificarRotaPublicacaoManualDepoisDaReserva(texto) {
  const reserva = posicao(texto, "reserva = tentarReservarPublicacao({", ROTA_PUBLICACAO);
  const decisao = posicao(texto, "const motivoDepoisDaReserva = motivoDeRecusaDaPublicacaoManual({", ROTA_PUBLICACAO);
  const recusa = posicao(texto, "if (motivoDepoisDaReserva) {", ROTA_PUBLICACAO);
  assert.ok(reserva < decisao && decisao < recusa, "a confirmação tem de vir depois da reserva");
  assert.match(
    texto.slice(recusa, recusa + 400),
    /reserva\.libertar\(\);[\s\S]*return Response\.json\(\{ ok: false, error: motivoDepoisDaReserva \}, \{ status: 409 \}\);/,
    "a confirmação tem de libertar a reserva e responder 409"
  );
}

const ROTA_CICLO = "app/routes/api.trigger-sync.jsx";
function verificarRotaCiclo(texto) {
  const decisao = posicao(texto, "const recusaScript = motivoDeRecusaPorScript(atividadeScript);", ROTA_CICLO);
  const iife = posicao(texto, "void (async () => {", ROTA_CICLO);
  assert.ok(decisao < iife, "o ciclo tem de recusar com script antes de arrancar o IIFE");
  const bloco = texto.slice(decisao, iife);
  assert.match(
    bloco,
    /return Response\.json\(\s*\{ ok: true, skipped: true, reason: "script_indexing_running" \},\s*\{ status: 409/,
    "a recusa do ciclo tem de ser um return com reason e 409"
  );
}

/** Os dois scripts de reindexação retiram a marca em sinal (terminal fechado, SIGTERM). Os outros scripts de escrita não têm tratador de sinal. */
function verificarSinaisDoScript(texto, rel) {
  assert.match(texto, /for \(const sinal of \["SIGHUP", "SIGINT", "SIGTERM"\]\) \{/, `${rel}: os sinais tratados têm de ser SIGHUP, SIGINT e SIGTERM`);
  assert.match(texto, /process\.on\(sinal, \(\) => \{\s*retirarMarcador\(\);/, `${rel}: o tratador de sinal tem de retirar a marca`);
}

/** Marca falhada no ciclo: o ciclo para e não segue para as coleções. */
function verificarCicloParaSemMarca(texto) {
  const inicio = posicao(texto, "if (marcaFalhou) {", ROTA_CICLO);
  const fim = posicao(texto, "} else if (!reserva) {", ROTA_CICLO);
  assert.ok(inicio < fim, "o ramo de marca falhada vem antes do ramo de reserva");
  assert.match(texto.slice(inicio, fim), /markMarginErosionCycleSkipped\(shop[\s\S]*return;/, "a marca falhada tem de parar o ciclo");
}

function verificarCicloParaComConfirmacao(texto) {
  const inicio = posicao(texto, "let decisao = null;", ROTA_CICLO);
  const fim = posicao(texto, "if (decisao) {", ROTA_CICLO);
  assert.ok(inicio < fim, "a decisão de indexação do ciclo tem de vir antes da recusa");
  assert.doesNotMatch(texto.slice(inicio, fim), /throw/, "a confirmação não lança: converte o erro em motivo");
  const fimDoRamo = texto.indexOf("} else {", fim);
  assert.ok(fimDoRamo > fim, "o ramo com motivo tem de ter else");
  const ramo = texto.slice(fim, fimDoRamo);
  assert.match(ramo, /return;/, "com motivo, o ciclo para: não publica nem corre as coleções");
}

function verificarCicloPublicacao(texto) {
  const pos = posicao(texto, "if (publicacaoOuResetEmCurso()) {", ROTA_CICLO);
  const sync = posicao(texto, "if (await isShopifySyncRunning(shop)) {", ROTA_CICLO);
  assert.ok(pos < sync, "o POST tem de recusar com reset ou publicação antes do IIFE");
  assert.match(texto.slice(pos, sync), /reason: "publish_or_reset_running" \},\s*\{ status: 409/, "a recusa tem de ser 409 com causa");
  const marca = posicao(texto, 'reserva = tentarReservarPublicacao({ marcar: () => marcarAtividadeApp({ tipo: "publicacao" }) });', ROTA_CICLO);
  const decisao = posicao(texto, "decisao = decisaoDaPublicacaoManual({", ROTA_CICLO);
  assert.ok(marca < decisao, "a confirmação da indexação tem de vir depois da reserva com marca");
}

/** Purga: marca como script antes do arranque, e uma recusa do worker sai com código 1. */
const PURGA = "scripts/catalog/catalog-purge-reindex.js";
function verificarPurga(texto) {
  const recusa = posicao(texto, 'recusarSeAtividadeApp("catalog-purge-reindex");', PURGA);
  const marca = posicao(texto, 'marcarAtividadeApp({ tipo: "indexacao", origem: "script" })', PURGA);
  const arranque = posicao(texto, "concluiu = await startCatalogCleanupInBackground(shop, settings", PURGA);
  assert.ok(recusa < marca && marca < arranque, "a purga recusa, marca e só depois arranca o worker");
  const i = texto.indexOf("if (concluiu === false) {");
  assert.ok(i >= 0, "a purga tem de tratar o caso que não concluiu");
  const bloco = texto.slice(i, texto.indexOf("\n}", i));
  assert.match(bloco, /process\.exit\(1\);/, "uma corrida que não concluiu sai com código 1");
  assert.doesNotMatch(bloco, /process\.exit\(0\)/, "o ramo que não concluiu não pode sair com código 0");
}

function verificarCicloAbortaSemArranque(texto) {
  const arranque = posicao(texto, "const arranque = await startCatalogIndexingWorker(", ROTA_CICLO);
  const aborto = posicao(texto, "if (arranque === null) {", ROTA_CICLO);
  const prazo = posicao(texto, "const deadline = Date.now() + INDEXING_TIMEOUT_MS;", ROTA_CICLO);
  assert.ok(arranque < aborto && aborto < prazo, "o aborto tem de vir logo depois do arranque");
  assert.match(texto.slice(aborto, prazo), /return;/, "o aborto tem de sair do IIFE");
}

const ROTA_PAINEL = "app/routes/app._index.jsx";
function verificarPainel(texto) {
  const recusa = posicao(texto, "const recusaScript = motivoDeRecusaPorScript(scriptDeIndexacaoEmCurso());", ROTA_PAINEL);
  const retoma = posicao(texto, "startCatalogRebuildInBackground(session.shop", ROTA_PAINEL);
  const purga = posicao(texto, "startCatalogCleanupInBackground(session.shop", ROTA_PAINEL);
  assert.ok(recusa < retoma && recusa < purga, "o painel tem de recusar antes de arrancar a reindexação ou a purga");
  assert.ok(posicao(texto, "const fileStatus = await readCatalogRebuildStatus(session.shop);", ROTA_PAINEL) < recusa, "a recusa vem depois do último await");
  assert.ok(!texto.slice(recusa, retoma).includes("await"), "sem await entre a recusa e o arranque");
  assert.match(texto.slice(recusa, retoma), /if \(publicacaoOuResetEmCurso\(\)\) \{/, "a publicação ou o reset também recusa, na mesma verificação");
  assert.match(
    texto.slice(recusa, retoma),
    /return \{ ok: false, error: recusaScript \};/,
    "o painel tem de devolver a causa com return"
  );
}

const ROTA_RESET = "app/routes/api.shopify-reset.jsx";
function verificarRotaReset(texto) {
  const reserva = posicao(texto, "reserva = tentarReservarPublicacao({", ROTA_RESET);
  const arranque = posicao(texto, "startShopifyCatalogResetInBackground(session, { reserva });", ROTA_RESET);
  assert.ok(reserva < arranque, "o reset tem de tomar a reserva antes de arrancar o job");
  posicao(texto, 'tentarReservarPublicacao({ marcar: () => marcarAtividadeApp({ tipo: "publicacao" }) })', ROTA_RESET);
  const confirmacao = posicao(texto, "motivoDepoisDaReserva = motivoDeRecusaDoReset({", ROTA_RESET);
  const aguarda = posicao(texto, "await loadOfflineSessionForShop(session.shop);", ROTA_RESET);
  assert.ok(reserva < confirmacao && confirmacao < aguarda, "o reset confirma a indexação depois de tomar a reserva");
  verificarLibertacaoNosCaminhosDeErro(texto);
}

/** Cada caminho de erro entre a reserva e o arranque do job tem de libertar a reserva antes de sair. */
function verificarLibertacaoNosCaminhosDeErro(texto) {
  const inicio = posicao(texto, "reserva = tentarReservarPublicacao({", ROTA_RESET);
  const arranque = posicao(texto, "startShopifyCatalogResetInBackground(session, { reserva });", ROTA_RESET);
  const caminhos = [
    "reserva.libertar();\n      return Response.json({ ok: false, error: motivoDepoisDaReserva }",
    "reserva.libertar();\n    throw err;\n  }\n\n  try {\n    await loadOfflineSessionForShop(session.shop);",
    "reserva.libertar();\n    const message =",
    "reserva.libertar();\n    throw err;\n  }\n  startShopifyCatalogResetInBackground(session, { reserva });",
  ];
  for (const caminho of caminhos) {
    const i = texto.indexOf(caminho);
    assert.ok(i > inicio && i < arranque, `caminho de erro sem libertação da reserva: ${caminho.slice(0, 60)}`);
  }
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
    const alheio = processoAlheio();
    const marca = atividade.marcarAtividadeApp({ tipo: "indexacao", pid: alheio.pid, origem: "script" });
    let recusado;
    try {
      recusado = await indexacao.startCatalogIndexingWorker(shop, {}, { causa: "ciclo" });
    } finally {
      marca();
      alheio.kill();
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
    trocaUnica(t, "  if (atividadeScript) {\n    // A causa vem da guarda", "  if (false) {\n    // A causa vem da guarda")
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
    const alheio = processoAlheio();
    const marca = atividade.marcarAtividadeApp({ tipo: "indexacao", pid: alheio.pid, origem: "script" });
    try {
      await mod.startCatalogIndexingWorker("loja-mutante.myshopify.com", {}, { causa: "ciclo" });
    } finally {
      marca();
      alheio.kill();
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
    trocaUnica(t, "  if (indexacaoEmCurso) {\n    return { causa: \"indexação em curso\", mensagem: \"Aguarda que a indexação do catálogo termine antes de publicar.\" };", "  if (false) {\n    return { causa: \"indexação em curso\", mensagem: \"Aguarda que a indexação do catálogo termine antes de publicar.\" };")
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
  const alheio = processoAlheio();
  const marcaScript = atividade.marcarAtividadeApp({ tipo: "indexacao", pid: alheio.pid, origem: "script" });
  try {
    const script = atividade.scriptDeIndexacaoEmCurso();
    assert.equal(script?.tipo, "script");
    assert.equal(script?.pid, alheio.pid);
  } finally {
    marcaScript();
    alheio.kill();
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
    verificarRotaCiclo(trocaUnica(texto, "const recusaScript = motivoDeRecusaPorScript(atividadeScript);", "const recusaScript = null;"))
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
    verificarRotaReset(trocaUnica(texto, "reserva = tentarReservarPublicacao({ marcar: () => marcarAtividadeApp({ tipo: \"publicacao\" }) });", "reserva = { libertar() {} };"))
  );
});

await caso("mutação: o reset deixa de libertar a reserva no fim (o caso (e) do background tem de ficar vermelho)", () => {
  const texto = ler(RESET_BG);
  assert.throws(() =>
    verificarLibertacaoDoReset(trocaUnica(texto, "      .finally(() => opts.reserva?.libertar());", ""))
  );
});

// --- Casos novos (revisão adversarial do PR 5) ---

/** Origens dos marcadores de indexação que existem neste instante. Lido dentro do fork, como o arranque os vê. */
function origensDosMarcadores() {
  const dir = dados.resolveCurationDataDir();
  return marcadoresDeIndexacao()
    .map((nome) => JSON.parse(fs.readFileSync(path.join(dir, nome), "utf8")).origem ?? "app")
    .sort();
}

await caso("(f) a corrida de um script leva origem script; a da app leva origem app", async () => {
  limparMarcadores();
  const origens = [];
  let filho = null;
  indexacao.definirForkParaTestes(() => {
    origens.push(origensDosMarcadores());
    filho = new FakeChild();
    return filho;
  });
  try {
    const purga = indexacao.startCatalogCleanupInBackground(SHOP_ORIGEM, {}, { causa: "script" });
    await esperarAte(() => filho !== null);
    filho.emit("message", { type: "done", indexed: 1, scanned: 1 });
    await purga;
    filho.emit("exit", 0, null);
    filho = null;

    await indexacao.startCatalogIndexingWorker("loja-origem-app.myshopify.com", {}, { causa: "painel" });
    await esperarAte(() => filho !== null);
    filho.emit("exit", 0, null);
  } finally {
    indexacao.definirForkParaTestes(null);
    limparMarcadores();
  }
  assert.deepEqual(origens, [["script"], ["app"]], "a purga por script tem de ser vista como script");
});

await caso("mutação: origem fixa em app faz o caso (f) ficar vermelho", async () => {
  const m = mutanteDo("lib/importer/catalog/indexingStream.server.js", "origem-fixa", (t) =>
    trocaUnica(t, 'origem: opts.causa === "script" ? "script" : "app" });', 'origem: "app" });')
  );
  limparMarcadores();
  const origens = [];
  let filho = null;
  const mod = await import(pathToFileURL(m).href);
  mod.definirForkParaTestes(() => {
    origens.push(origensDosMarcadores());
    filho = new FakeChild();
    return filho;
  });
  try {
    const purga = mod.startCatalogCleanupInBackground(SHOP_ORIGEM, {}, { causa: "script" });
    await esperarAte(() => filho !== null);
    filho.emit("message", { type: "done", indexed: 1, scanned: 1 });
    await purga;
    filho.emit("exit", 0, null);
    assert.notDeepEqual(origens, [["script"]], "a mutação tem de deixar a purga como app, e o caso (f) tem de apanhar isso");
  } finally {
    mod.definirForkParaTestes(null);
    limparMarcadores();
    fs.rmSync(m, { force: true });
  }
});

await caso("(g) com uma publicação ou um reset com a reserva tomada, a indexação não arranca; livre, arranca", async () => {
  const shop = "loja-reserva-indexacao.myshopify.com";
  let forks = 0;
  const filhos = [];
  indexacao.definirForkParaTestes(() => {
    forks += 1;
    const c = new FakeChild();
    filhos.push(c);
    return c;
  });
  const reserva = publicacao.tentarReservarPublicacao();
  try {
    const recusado = await indexacao.startCatalogIndexingWorker(shop, {}, { causa: "ciclo" });
    assert.equal(recusado, null, "com a reserva tomada, a indexação não arranca");
    assert.equal(forks, 0, "sem reserva livre não pode haver fork");
    assert.equal(fs.existsSync(ficheiroDoEstado(shop)), false, "a recusa não grava estado");
    reserva.libertar();
    const arrancou = await indexacao.startCatalogIndexingWorker(shop, {}, { causa: "ciclo" });
    assert.notEqual(arrancou, null, "com a reserva livre, a indexação arranca");
    assert.equal(forks, 1);
    filhos[0].emit("exit", 0, null);
  } finally {
    reserva.libertar();
    indexacao.definirForkParaTestes(null);
  }
});

await caso("mutação: sem a recusa por publicação, a indexação faz fork com a reserva tomada (o caso (g) tem de ficar vermelho)", async () => {
  const m = mutanteDo("lib/importer/catalog/indexingStream.server.js", "sem-recusa-publicacao", (t) =>
    trocaUnica(t, "  if (publicacaoOuResetEmCurso()) {", "  if (false) {")
  );
  let forks = 0;
  const filhos = [];
  const mod = await import(pathToFileURL(m).href);
  mod.definirForkParaTestes(() => {
    forks += 1;
    const c = new FakeChild();
    filhos.push(c);
    return c;
  });
  const reserva = publicacao.tentarReservarPublicacao();
  try {
    await mod.startCatalogIndexingWorker("loja-mutante-reserva.myshopify.com", {}, { causa: "ciclo" });
    assert.notEqual(forks, 0, "a mutação tem de fazer fork com a reserva tomada, e o caso (g) tem de apanhar isso");
  } finally {
    reserva.libertar();
    mod.definirForkParaTestes(null);
    for (const c of filhos) c.emit("exit", 0, null);
    fs.rmSync(m, { force: true });
  }
});

await caso("(h) a publicação manual confirma a indexação depois de tomar a reserva", () => {
  verificarRotaPublicacaoManualDepoisDaReserva(ler(ROTA_PUBLICACAO));
});

await caso("mutação: sem a confirmação depois da reserva, o caso (h) tem de ficar vermelho", () => {
  const texto = ler(ROTA_PUBLICACAO);
  assert.throws(() =>
    verificarRotaPublicacaoManualDepoisDaReserva(trocaUnica(texto, "if (motivoDepoisDaReserva) {", "if (false) {"))
  );
});

await caso("(i) o ciclo para quando a indexação não arranca, antes da publicação", () => {
  verificarCicloAbortaSemArranque(ler(ROTA_CICLO));
});

await caso("mutação: sem o aborto, o ciclo segue para a publicação e o caso (i) tem de ficar vermelho", () => {
  const texto = ler(ROTA_CICLO);
  assert.throws(() =>
    verificarCicloAbortaSemArranque(trocaUnica(texto, "if (arranque === null) {", "if (false) {"))
  );
});

await caso("(j) marcador ilegível: conta enquanto é recente, e deixa de contar ao fim de 10 min", () => {
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const ficheiro = path.join(dir, "catalog-busy-indexacao-1-ilegivel.json");
  fs.writeFileSync(ficheiro, "{ truncado", "utf8");
  try {
    assert.equal(atividade.scriptDeIndexacaoEmCurso()?.tipo, "desconhecida", "recente: fail closed");
    const antigo = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(ficheiro, antigo, antigo);
    assert.equal(atividade.scriptDeIndexacaoEmCurso(), null, "com mais de 10 min é sobra e não bloqueia para sempre");
  } finally {
    fs.rmSync(ficheiro, { force: true });
  }
});

await caso("mutação: sem o prazo, o marcador ilegível antigo bloqueia para sempre (o caso (j) tem de ficar vermelho)", async () => {
  const m = mutanteDo("lib/curation/atividadeApp.js", "sem-prazo-de-sobra", (t) =>
    trocaUnica(t, "  if (idadeDoMarcadorMs(ficheiro) <= IDADE_DE_SOBRA_MS) return false;", "  if (true) return false;")
  );
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const ficheiro = path.join(dir, "catalog-busy-indexacao-1-ilegivel.json");
  fs.writeFileSync(ficheiro, "{ truncado", "utf8");
  const antigo = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(ficheiro, antigo, antigo);
  try {
    const mod = await import(pathToFileURL(m).href);
    assert.notEqual(mod.scriptDeIndexacaoEmCurso(), null, "a mutação tem de bloquear com o marcador antigo, e o caso (j) tem de apanhar isso");
  } finally {
    fs.rmSync(ficheiro, { force: true });
    fs.rmSync(m, { force: true });
  }
});

await caso("(k) a idade do marcador ilegível vem do relógio do ficheiro, não do relógio de quem lê", () => {
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const ficheiro = path.join(dir, "catalog-busy-indexacao-1-recente.json");
  fs.writeFileSync(ficheiro, "{ truncado", "utf8");
  const relogio = Date.now;
  // O leitor acha que passou uma hora. O ficheiro acabou de ser escrito, por isso continua dentro do prazo.
  Date.now = () => relogio() + 60 * 60 * 1000;
  try {
    assert.equal(atividade.scriptDeIndexacaoEmCurso()?.tipo, "desconhecida", "o marcador é recente no relógio do ficheiro");
  } finally {
    Date.now = relogio;
    fs.rmSync(ficheiro, { force: true });
  }
});

await caso("mutação: idade pelo relógio de quem lê faz o caso (k) ficar vermelho", async () => {
  const m = mutanteDo("lib/curation/atividadeApp.js", "relogio-do-leitor", (t) =>
    trocaUnica(t, "  if (idadeDoMarcadorMs(ficheiro) <= IDADE_DE_SOBRA_MS) return false;", "  if (Date.now() - fs.statSync(ficheiro).mtimeMs <= IDADE_DE_SOBRA_MS) return false;")
  );
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const ficheiro = path.join(dir, "catalog-busy-indexacao-1-recente.json");
  fs.writeFileSync(ficheiro, "{ truncado", "utf8");
  const relogio = Date.now;
  Date.now = () => relogio() + 60 * 60 * 1000;
  try {
    const mod = await import(pathToFileURL(m).href);
    const r = mod.scriptDeIndexacaoEmCurso();
    assert.notEqual(r?.tipo, "desconhecida", "a mutação tem de deixar passar o marcador, e o caso (k) tem de apanhar isso");
  } finally {
    Date.now = relogio;
    fs.rmSync(ficheiro, { force: true });
    fs.rmSync(m, { force: true });
  }
});

await caso("(l) o marcador ilegível expirado deixa uma linha de aviso com a causa", () => {
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const ficheiro = path.join(dir, "catalog-busy-indexacao-1-antigo.json");
  fs.writeFileSync(ficheiro, "{ truncado", "utf8");
  const antigo = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(ficheiro, antigo, antigo);
  const avisos = [];
  const original = console.warn;
  console.warn = (...args) => avisos.push(args.join(" "));
  try {
    assert.equal(atividade.scriptDeIndexacaoEmCurso(), null, "expirado não bloqueia");
  } finally {
    console.warn = original;
    fs.rmSync(ficheiro, { force: true });
  }
  assert.ok(avisos.some((l) => /causa=marcador_ilegivel_expirado/.test(l)), "tem de haver aviso com a causa marcador_ilegivel_expirado");
});

await caso("mutação: sem o aviso, o caso (l) tem de ficar vermelho", async () => {
  const m = mutanteDo("lib/curation/atividadeApp.js", "sem-aviso", (t) =>
    trocaUnica(t, "  console.warn(`[atividade] causa=marcador_ilegivel_expirado: ${nome} ignorado (mais de 10 min).`);", "")
  );
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const ficheiro = path.join(dir, "catalog-busy-indexacao-1-antigo.json");
  fs.writeFileSync(ficheiro, "{ truncado", "utf8");
  const antigo = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(ficheiro, antigo, antigo);
  const avisos = [];
  const original = console.warn;
  console.warn = (...args) => avisos.push(args.join(" "));
  try {
    const mod = await import(pathToFileURL(m).href);
    mod.scriptDeIndexacaoEmCurso();
  } finally {
    console.warn = original;
    fs.rmSync(ficheiro, { force: true });
    fs.rmSync(m, { force: true });
  }
  assert.throws(
    () => assert.ok(avisos.some((l) => /causa=marcador_ilegivel_expirado/.test(l)), "tem de haver aviso"),
    /tem de haver aviso/,
    "a mutação não pode deixar o aviso, e o caso (l) tem de apanhar isso"
  );
});

// --- Revisão de convergência (PR 5, segunda rodada) ---

const ROTA_CICLO_PUB = "app/routes/api.trigger-sync.jsx";

await caso("(m) marcador ilegível expirado não bloqueia o reset nem os scripts de escrita, e deixa aviso", () => {
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const ficheiro = path.join(dir, "catalog-busy-indexacao-1-expirado.json");
  fs.writeFileSync(ficheiro, "{ truncado", "utf8");
  const antigo = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(ficheiro, antigo, antigo);
  const avisos = [];
  const original = console.warn;
  console.warn = (...args) => avisos.push(args.join(" "));
  try {
    assert.equal(atividade.atividadeAppEmCurso(), null, "expirado não bloqueia o reset nem os scripts");
  } finally {
    console.warn = original;
    fs.rmSync(ficheiro, { force: true });
  }
  assert.ok(avisos.some((l) => /causa=marcador_ilegivel_expirado/.test(l)), "tem de haver aviso com a causa");
});

await caso("mutação: o reset e os scripts continuam a bloquear com o marcador expirado (o caso (m) tem de ficar vermelho)", async () => {
  const m = mutanteDo("lib/curation/atividadeApp.js", "reset-sem-prazo", (t) =>
    trocaUnica(t, '      if (marcadorIlegivelExpirou(path.join(dir, nome), nome)) continue;\n      return { tipo: "desconhecida"', '      return { tipo: "desconhecida"')
  );
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const ficheiro = path.join(dir, "catalog-busy-indexacao-1-expirado.json");
  fs.writeFileSync(ficheiro, "{ truncado", "utf8");
  const antigo = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(ficheiro, antigo, antigo);
  try {
    const mod = await import(pathToFileURL(m).href);
    assert.notEqual(mod.atividadeAppEmCurso(), null, "a mutação tem de continuar a bloquear, e o caso (m) tem de apanhar isso");
    assert.equal(mod.atividadeAppEmCurso()?.tipo, "desconhecida");
  } finally {
    fs.rmSync(ficheiro, { force: true });
    fs.rmSync(m, { force: true });
  }
});

await caso("(n) a guarda ignora a marca do próprio processo: a purga não se recusa a si própria", async () => {
  limparMarcadores();
  let forks = 0;
  const filhos = [];
  indexacao.definirForkParaTestes(() => {
    forks += 1;
    const c = new FakeChild();
    filhos.push(c);
    return c;
  });
  const marca = atividade.marcarAtividadeApp({ tipo: "indexacao", pid: process.pid, origem: "script" });
  try {
    const arrancou = await indexacao.startCatalogIndexingWorker("loja-propria.myshopify.com", {}, { causa: "script" });
    assert.notEqual(arrancou, null, "a marca do próprio processo não recusa");
    assert.equal(forks, 1);
    filhos[0].emit("exit", 0, null);
  } finally {
    marca();
    indexacao.definirForkParaTestes(null);
  }
});

await caso("mutação: sem a exceção da marca própria, o script recusa-se a si próprio (o caso (n) tem de ficar vermelho)", async () => {
  const m = mutanteDo("lib/curation/atividadeApp.js", "sem-marca-propria", (t) =>
    trocaUnica(t, "    if (dados.pid === process.pid && dados.processo === PROCESSO_ID) continue;\n", "")
  );
  limparMarcadores();
  const marca = atividade.marcarAtividadeApp({ tipo: "indexacao", pid: process.pid, origem: "script" });
  try {
    const mod = await import(pathToFileURL(m).href);
    assert.notEqual(mod.scriptDeIndexacaoEmCurso(), null, "a mutação tem de achar a marca própria, e o caso (n) tem de apanhar isso");
  } finally {
    marca();
    fs.rmSync(m, { force: true });
  }
});

await caso("(o) a reserva leva a marca da app: existe enquanto a reserva está tomada, e sai com libertar", () => {
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const marcas = () => fs.readdirSync(dir).filter((n) => n.startsWith("catalog-busy-publicacao-")).length;
  const reserva = publicacao.tentarReservarPublicacao({ marcar: () => atividade.marcarAtividadeApp({ tipo: "publicacao" }) });
  try {
    assert.equal(publicacao.publicacaoOuResetEmCurso(), true);
    assert.equal(marcas(), 1, "a marca existe com a reserva");
  } finally {
    reserva.libertar();
  }
  assert.equal(publicacao.publicacaoOuResetEmCurso(), false);
  assert.equal(marcas(), 0, "libertar retira a marca");
});

await caso("(o) se a marca da app falhar, a reserva sai e o erro sobe (fail closed)", () => {
  assert.throws(() => publicacao.tentarReservarPublicacao({ marcar: () => { throw new Error("sem marca"); } }), /sem marca/);
  assert.equal(publicacao.publicacaoOuResetEmCurso(), false, "a reserva não pode ficar presa");
});

await caso("mutação: libertar não retira a marca (o caso (o) tem de ficar vermelho)", async () => {
  const m = mutanteDo("lib/importer/shopify/publicacaoEmCurso.js", "libertar-sem-marca", (t) =>
    trocaUnica(t, "      if (reservada === dona) reservada = null;\n      retirarMarca();", "      if (reservada === dona) reservada = null;")
  );
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  try {
    const mod = await import(pathToFileURL(m).href);
    const reserva = mod.tentarReservarPublicacao({ marcar: () => atividade.marcarAtividadeApp({ tipo: "publicacao" }) });
    reserva.libertar();
    const restantes = fs.readdirSync(dir).filter((n) => n.startsWith("catalog-busy-publicacao-")).length;
    assert.notEqual(restantes, 0, "a mutação deixa a marca, e o caso (o) tem de apanhar isso");
  } finally {
    limparMarcadores();
    fs.rmSync(m, { force: true });
  }
});

await caso("mutação: a falha da marca deixa a reserva presa (o caso (o) tem de ficar vermelho)", async () => {
  const m = mutanteDo("lib/importer/shopify/publicacaoEmCurso.js", "falha-presa", (t) =>
    trocaUnica(t, "      if (reservada === dona) reservada = null;\n      throw err;", "      throw err;")
  );
  try {
    const mod = await import(pathToFileURL(m).href);
    assert.throws(() => mod.tentarReservarPublicacao({ marcar: () => { throw new Error("sem marca"); } }), /sem marca/);
    assert.notEqual(mod.publicacaoOuResetEmCurso(), false, "a mutação deixa a reserva presa, e o caso (o) tem de apanhar isso");
  } finally {
    fs.rmSync(m, { force: true });
  }
});

await caso("(p) a purga recusa, marca-se como script antes do arranque, e uma recusa do worker sai com código 1", () => {
  verificarPurga(ler(PURGA));
});

await caso("mutação: a purga não se marca antes do arranque (o caso (p) tem de ficar vermelho)", () => {
  const texto = ler(PURGA);
  assert.throws(() =>
    verificarPurga(trocaUnica(texto, '  retirarMarcador = marcarAtividadeApp({ tipo: "indexacao", origem: "script" });', "  retirarMarcador = () => {};"))
  );
});

await caso("mutação: uma recusa do worker deixa de sair com código 1 (o caso (p) tem de ficar vermelho)", () => {
  const texto = ler(PURGA);
  assert.throws(() => verificarPurga(trocaUnica(texto, "if (concluiu === false) {", "if (concluiu === undefined) {")));
});

await caso("(q) ciclo: o POST responde 409 com reset ou publicação, e a indexação é confirmada depois da reserva com marca", () => {
  verificarCicloPublicacao(ler(ROTA_CICLO_PUB));
});

await caso("mutação: o POST deixa de recusar com reset ou publicação (o caso (q) tem de ficar vermelho)", () => {
  assert.throws(() => verificarCicloPublicacao(trocaUnica(ler(ROTA_CICLO_PUB), "if (publicacaoOuResetEmCurso()) {", "if (false) {")));
});

await caso("mutação: o POST responde 200 em vez de 409 (o caso (q) tem de ficar vermelho)", () => {
  const texto = ler(ROTA_CICLO_PUB);
  assert.throws(() =>
    verificarCicloPublicacao(trocaUnica(texto, 'reason: "publish_or_reset_running" },\n      { status: 409', 'reason: "publish_or_reset_running" },\n      { status: 200'))
  );
});

await caso("mutação: o ciclo confirma a indexação sem repetir a decisão depois da reserva (o caso (q) tem de ficar vermelho)", () => {
  assert.throws(() => verificarCicloPublicacao(trocaUnica(ler(ROTA_CICLO_PUB), "decisao = decisaoDaPublicacaoManual({", "decisao = null({")));
});

await caso("mutação: o ciclo reserva sem marca da app (o caso (q) tem de ficar vermelho)", () => {
  assert.throws(() =>
    verificarCicloPublicacao(trocaUnica(ler(ROTA_CICLO_PUB), 'reserva = tentarReservarPublicacao({ marcar: () => marcarAtividadeApp({ tipo: "publicacao" }) });', "reserva = tentarReservarPublicacao();"))
  );
});

await caso("mutação: a publicação manual reserva sem marca da app (o caso (d) da rota tem de ficar vermelho)", () => {
  assert.throws(() =>
    verificarRotaPublicacaoManual(trocaUnica(ler(ROTA_PUBLICACAO), 'reserva = tentarReservarPublicacao({ marcar: () => marcarAtividadeApp({ tipo: "publicacao" }) });', "reserva = tentarReservarPublicacao();"))
  );
});

await caso("mutação: o reset deixa de confirmar a indexação depois da reserva (o caso do reset tem de ficar vermelho)", () => {
  assert.throws(() => verificarRotaReset(trocaUnica(ler(ROTA_RESET), "motivoDepoisDaReserva = motivoDeRecusaDoReset({", "motivoDepoisDaReserva = null({")));
});

await caso("mutação: o painel deixa de recusar com publicação em curso (o caso do painel tem de ficar vermelho)", () => {
  assert.throws(() => verificarPainel(trocaUnica(ler(ROTA_PAINEL), "if (publicacaoOuResetEmCurso()) {", "if (false) {")));
});

// --- Rodada 2 de convergência: leitura, identificador de processo, mensagem por tipo, marca falhada, purga ---

await caso("(r) erro de leitura de marcador de script vivo há mais de 10 min continua a bloquear (não é conteúdo ilegível)", () => {
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const pasta = path.join(dir, "catalog-busy-indexacao-1-dirlido.json");
  fs.mkdirSync(pasta);
  const antigo = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(pasta, antigo, antigo);
  try {
    assert.equal(atividade.scriptDeIndexacaoEmCurso()?.tipo, "desconhecida", "erro de leitura não expira pelo prazo");
    assert.equal(atividade.atividadeAppEmCurso()?.tipo, "desconhecida", "o reset também não expira com erro de leitura");
  } finally {
    fs.rmdirSync(pasta);
  }
});

await caso("mutação: erro de leitura expira pelo prazo e deixa passar a indexação (o caso (r) tem de ficar vermelho)", async () => {
  const m = mutanteDo("lib/curation/atividadeApp.js", "leitura-expira", (t) =>
    trocaUnica(t, '      desconhecido = desconhecido || { tipo: "desconhecida", causa: "leitura", pid: null, motivo: `${ficheiro} (${err?.code || "erro"})` };', '      if (marcadorIlegivelExpirou(ficheiro, nome)) continue;\n      desconhecido = desconhecido || { tipo: "desconhecida", causa: "leitura", pid: null, motivo: `${ficheiro} (${err?.code || "erro"})` };')
  );
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const pasta = path.join(dir, "catalog-busy-indexacao-1-dirlido.json");
  fs.mkdirSync(pasta);
  const antigo = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(pasta, antigo, antigo);
  try {
    const mod = await import(pathToFileURL(m).href);
    assert.equal(mod.scriptDeIndexacaoEmCurso(), null, "a mutação deixa passar com erro de leitura antigo");
    assert.throws(() => assert.equal(mod.scriptDeIndexacaoEmCurso()?.tipo, "desconhecida"), "o caso (r) tem de apanhar a mutação");
  } finally {
    fs.rmdirSync(pasta);
    fs.rmSync(m, { force: true });
  }
});

await caso("(s) a mesma pid de outro processo (outro container) não é a marca própria: recusa", () => {
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const ficheiro = path.join(dir, "catalog-busy-indexacao-1-outro-container.json");
  fs.writeFileSync(ficheiro, JSON.stringify({ tipo: "indexacao", pid: process.pid, origem: "script", processo: "outro-container", startedAt: new Date().toISOString() }), "utf8");
  try {
    assert.equal(atividade.scriptDeIndexacaoEmCurso()?.tipo, "script", "mesmo pid, outro processo: tem de recusar");
  } finally {
    fs.rmSync(ficheiro, { force: true });
  }
});

await caso("mutação: a exceção pelo pid apenas deixa passar a marca de outro container (o caso (s) tem de ficar vermelho)", async () => {
  const m = mutanteDo("lib/curation/atividadeApp.js", "pid-apenas", (t) =>
    trocaUnica(t, "    if (dados.pid === process.pid && dados.processo === PROCESSO_ID) continue;", "    if (dados.pid === process.pid) continue;")
  );
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const ficheiro = path.join(dir, "catalog-busy-indexacao-1-outro-container.json");
  fs.writeFileSync(ficheiro, JSON.stringify({ tipo: "indexacao", pid: process.pid, origem: "script", processo: "outro-container", startedAt: new Date().toISOString() }), "utf8");
  try {
    const mod = await import(pathToFileURL(m).href);
    assert.equal(mod.scriptDeIndexacaoEmCurso(), null, "a mutação ignora a marca de outro container");
    assert.throws(() => assert.equal(mod.scriptDeIndexacaoEmCurso()?.tipo, "script"), "o caso (s) tem de apanhar a mutação");
  } finally {
    fs.rmSync(ficheiro, { force: true });
    fs.rmSync(m, { force: true });
  }
});

await caso("(t) marcador ilegível de publicação: a recusa diz marcador ilegível e não atribui a script", () => {
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const ficheiro = path.join(dir, "catalog-busy-publicacao-1-parcial.json");
  fs.writeFileSync(ficheiro, "{ truncado", "utf8");
  try {
    const motivo = atividade.motivoDeRecusaPorScript(atividade.scriptDeIndexacaoEmCurso());
    assert.match(motivo, /ilegível/, "a mensagem tem de dizer que o marcador é ilegível");
    assert.doesNotMatch(motivo, /Reindexação por script/, "não pode atribuir a recusa a um script que não existe");
  } finally {
    fs.rmSync(ficheiro, { force: true });
  }
});

await caso("mutação: a mensagem de marcador ilegível diz script (o caso (t) tem de ficar vermelho)", async () => {
  const m = mutanteDo("lib/curation/atividadeApp.js", "mensagem-script", (t) =>
    trocaUnica(t, '  if (atividadeScript.tipo === "desconhecida") {\n    const mensagem', "  if (false) {\n    const mensagem")
  );
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const ficheiro = path.join(dir, "catalog-busy-publicacao-1-parcial.json");
  fs.writeFileSync(ficheiro, "{ truncado", "utf8");
  try {
    const mod = await import(pathToFileURL(m).href);
    const motivo = mod.motivoDeRecusaPorScript(mod.scriptDeIndexacaoEmCurso());
    assert.match(motivo, /Reindexação por script/, "a mutação diz script");
    assert.throws(() => assert.doesNotMatch(motivo, /Reindexação por script/), "o caso (t) tem de apanhar a mutação");
  } finally {
    fs.rmSync(ficheiro, { force: true });
    fs.rmSync(m, { force: true });
  }
});

await caso("(z) os dois scripts de escrita retiram a marca também em sinal", () => {
  verificarSinaisDoScript(ler("scripts/catalog/full-catalog-reindex.js"), "full-catalog-reindex.js");
  verificarSinaisDoScript(ler("scripts/catalog/catalog-purge-reindex.js"), "catalog-purge-reindex.js");
});

await caso("mutação: o script não retira a marca em sinal (o caso (z) tem de ficar vermelho)", () => {
  const texto = ler("scripts/catalog/full-catalog-reindex.js");
  assert.throws(() =>
    verificarSinaisDoScript(trocaUnica(texto, "    retirarMarcador();\n    process.exit(sinal", "    process.exit(sinal"), "full-catalog-reindex.js")
  );
});

await caso("(z2) marca falhada no ciclo: o ciclo para e não segue para as coleções", () => {
  verificarCicloParaSemMarca(ler(ROTA_CICLO_PUB));
});

await caso("mutação: a marca falhada deixa o ciclo seguir (o caso (z2) tem de ficar vermelho)", () => {
  const texto = ler(ROTA_CICLO_PUB);
  assert.throws(() =>
    verificarCicloParaSemMarca(trocaUnica(texto, 'await markMarginErosionCycleSkipped(shop, "não foi possível marcar a atividade da app antes da publicação");\n          return;', 'await markMarginErosionCycleSkipped(shop, "não foi possível marcar a atividade da app antes da publicação");'))
  );
});

await caso("(y) marcador não lido por erro de leitura: a mensagem diz que não expira pelo tempo", () => {
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const pasta = path.join(dir, "catalog-busy-indexacao-1-dirlido.json");
  fs.mkdirSync(pasta);
  try {
    const motivo = atividade.motivoDeRecusaPorScript(atividade.scriptDeIndexacaoEmCurso());
    assert.match(motivo, /Não expira pelo tempo/, "um erro de leitura não expira, e a mensagem tem de o dizer");
    assert.doesNotMatch(motivo, /Expira 10 min/);
  } finally {
    fs.rmdirSync(pasta);
  }
});

await caso("mutação: a mensagem promete expiração (o caso (y) tem de ficar vermelho)", async () => {
  const m = mutanteDo("lib/curation/atividadeApp.js", "mensagem-espera", (t) =>
    trocaUnica(t, "Não expira pelo tempo. A leitura repete-se", "Expira 10 min. A leitura repete-se")
  );
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const pasta = path.join(dir, "catalog-busy-indexacao-1-dirlido.json");
  fs.mkdirSync(pasta);
  try {
    const mod = await import(pathToFileURL(m).href);
    const motivo = mod.motivoDeRecusaPorScript(mod.scriptDeIndexacaoEmCurso());
    assert.match(motivo, /Expira 10 min/, "a mutação promete expiração");
    assert.throws(() => assert.match(motivo, /Não expira pelo tempo/), "o caso (y) tem de apanhar a mutação");
  } finally {
    fs.rmdirSync(pasta);
    fs.rmSync(m, { force: true });
  }
});

await caso("(y2) marcador de script sem pid: a mensagem diz que não expira pelo tempo e só sai quando o ficheiro for apagado", () => {
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const ficheiro = path.join(dir, "catalog-busy-indexacao-1-sempid.json");
  fs.writeFileSync(ficheiro, JSON.stringify({ tipo: "indexacao", origem: "script", startedAt: new Date().toISOString() }));
  try {
    const motivo = atividade.motivoDeRecusaPorScript(atividade.scriptDeIndexacaoEmCurso());
    assert.match(motivo, /Marcador de script sem pid/, "a mensagem tem de dizer que o marcador não tem pid");
    assert.match(motivo, /Só sai quando o ficheiro for apagado/);
    assert.doesNotMatch(motivo, /Expira 10 min/, "sem pid não há expiração pelo tempo");
  } finally {
    fs.rmSync(ficheiro, { force: true });
  }
});

/** Worker de indexação: tem de sair quando o principal desaparece (PR 5, revisão, D2). */
const WORKER = "lib/workers/catalog-index-worker.mjs";
const SAIDA_COM_O_PAI = 'process.on("disconnect", () => process.exit(1));';
function verificarSaidaComOPai(texto) {
  assert.ok(texto.includes(SAIDA_COM_O_PAI), "o worker tem de sair quando o principal desaparece, senão fica órfão a escrever");
}

/** Um processo terminou quando já não existe, ou é zombie. Sem /proc não há prova, e o teste falha em vez de passar. */
function processoTerminou(pid) {
  if (!fs.existsSync("/proc")) throw new Error("o teste de saída do worker precisa de /proc (Linux)");
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat[stat.lastIndexOf(")") + 2] === "Z";
  } catch {
    return true;
  }
}

/**
 * Arranca o worker de verdade, com um pai que o forka e morre por SIGKILL depois de o worker mandar o progresso
 * csv-cache (antes do download). O feed do fornecedor é um servidor que nunca responde, por isso o worker fica preso
 * no download. Devolve true se o worker saiu em 5 s depois de o pai morrer. Sem o progresso, lança erro.
 */
async function workerSaiComOPai(caminhoDoWorker) {
  const feed = http.createServer(() => {});
  await new Promise((r) => feed.listen(0, "127.0.0.1", r));
  const pai = `
    import { fork } from "node:child_process";
    const filho = fork(process.env.WORKER_PATH, [process.env.PAYLOAD], { stdio: ["ignore", "ignore", "ignore", "ipc"], env: process.env });
    const limite = setTimeout(() => { console.log("sem-csv-cache"); process.exit(3); }, 30000);
    filho.on("message", (m) => {
      if (m && m.type === "progress" && m.phase === "csv-cache") {
        clearTimeout(limite);
        console.log("filho " + filho.pid);
        process.kill(process.pid, "SIGKILL");
      }
    });`;
  const payload = JSON.stringify({ shop: SHOP, settings: {}, runPurge: false, resume: false, checkpointScanned: 0 });
  const parente = spawn(process.execPath, ["-e", pai], {
    env: {
      ...process.env,
      PAYLOAD: payload,
      WORKER_PATH: caminhoDoWorker,
      OCIOSTOCK_FEED_URL: `http://127.0.0.1:${feed.address().port}/feed.csv`,
      OCIOSTOCK_CSV_PATH: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let saida = "";
  parente.stdout.on("data", (d) => (saida += d));
  parente.stderr.on("data", (d) => (saida += d));
  const fim = await new Promise((resolve) => parente.on("exit", (codigo, sinal) => resolve({ codigo, sinal })));
  const pid = Number((saida.match(/filho (\d+)/) || [])[1]);
  try {
    assert.ok(pid, `o worker não chegou ao download do CSV (pai: ${saida.trim() || "sem saída"}, código ${fim.codigo})`);
    assert.equal(fim.sinal, "SIGKILL", "o pai tem de morrer por SIGKILL, o caminho que o teste prova");
    const inicio = Date.now();
    while (!processoTerminou(pid)) {
      if (Date.now() - inicio > 5000) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
    return true;
  } finally {
    feed.closeAllConnections();
    feed.close();
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* já saiu */
      }
    }
  }
}

await caso("(aa) worker de verdade: com o principal morto por SIGKILL, o worker sai em 5 s", async () => {
  verificarSaidaComOPai(ler(WORKER));
  assert.equal(await workerSaiComOPai(path.join(RAIZ, WORKER)), true, "o worker ficou vivo 5 s depois de o principal morrer");
});

await caso("mutação: sem a saída no disconnect, o worker real fica vivo (o caso (aa) tem de ficar vermelho)", async () => {
  const m = mutanteDo(WORKER, "sem-saida-com-o-pai", (t) => trocaUnica(t, SAIDA_COM_O_PAI, ""));
  try {
    assert.equal(await workerSaiComOPai(m), false, "a mutação tem de deixar o worker vivo, e o caso (aa) tem de apanhar isso");
  } finally {
    fs.rmSync(m, { force: true });
  }
});

/** Texto do ciclo sem as linhas de comentário, para os pins de código. */
function semComentarios(texto) {
  return texto.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
}

const RELATORIO_DO_SALTO = "await markMarginErosionCycleSkipped(shop, `ciclo parado: ${decisao.causa}`);";
function verificarRelatorioDoSalto(texto) {
  assert.ok(semComentarios(texto).includes(RELATORIO_DO_SALTO), "o Relatório tem de receber a causa curta, em código e não em comentário");
  const inicio = posicao(texto, "if (decisao) {", ROTA_CICLO_PUB);
  const fim = texto.indexOf("} else {", inicio);
  const linha = posicao(texto, RELATORIO_DO_SALTO, ROTA_CICLO_PUB);
  assert.ok(linha > inicio && linha < fim, "o Relatório do salto tem de estar no ramo de recusa da confirmação");
}

await caso("(ab) ciclo: o salto da confirmação grava no Relatório a causa curta da decisão", () => {
  verificarRelatorioDoSalto(ler(ROTA_CICLO_PUB));
});

await caso("mutação: o Relatório recebe a frase da recusa (o caso (ab) tem de ficar vermelho)", () => {
  assert.throws(() => verificarRelatorioDoSalto(trocaUnica(ler(ROTA_CICLO_PUB), "${decisao.causa}`);", "${decisao.mensagem}`);")));
});

await caso("mutação: a linha do Relatório fica em comentário (o caso (ab) tem de ficar vermelho)", () => {
  assert.throws(() => verificarRelatorioDoSalto(trocaUnica(ler(ROTA_CICLO_PUB), RELATORIO_DO_SALTO, "// " + RELATORIO_DO_SALTO)));
});

const RELATORIO_DO_PEDIDO_SCRIPT = "await markMarginErosionCycleSkipped(shop, `ciclo saltado: ${causaDeRecusaPorScript(atividadeScript)}`);";
const RELATORIO_DO_PEDIDO_PUB = 'await markMarginErosionCycleSkipped(shop, "ciclo saltado: publicação ou reset Shopify em curso");';
/** A linha tem de estar dentro do ramo que começa em `abre` e acaba no primeiro return do POST. */
function noRamoDoPedido(texto, abre, linha) {
  const inicio = posicao(texto, abre, ROTA_CICLO_PUB);
  const pos = posicao(texto, linha, ROTA_CICLO_PUB);
  const fim = texto.indexOf("return Response.json", inicio);
  assert.ok(pos > inicio && pos < fim, `a linha tem de estar dentro de ${abre}`);
}
function verificarRelatorioDoPedido(texto) {
  const codigo = semComentarios(texto);
  assert.ok(codigo.includes(RELATORIO_DO_PEDIDO_SCRIPT), "a recusa por script do POST tem de ficar no Relatório");
  assert.ok(codigo.includes(RELATORIO_DO_PEDIDO_PUB), "a recusa por publicação ou reset do POST tem de ficar no Relatório");
  noRamoDoPedido(texto, "if (recusaScript) {", RELATORIO_DO_PEDIDO_SCRIPT);
  noRamoDoPedido(texto, "if (publicacaoOuResetEmCurso()) {", RELATORIO_DO_PEDIDO_PUB);
}

await caso("(ac) ciclo: o POST grava no Relatório as recusas que responde com 409 (script, publicação ou reset)", () => {
  verificarRelatorioDoPedido(ler(ROTA_CICLO_PUB));
});

await caso("mutação: a recusa por script deixa de ir ao Relatório (o caso (ac) tem de ficar vermelho)", () => {
  assert.throws(() => verificarRelatorioDoPedido(trocaUnica(ler(ROTA_CICLO_PUB), RELATORIO_DO_PEDIDO_SCRIPT, "")));
});

await caso("mutação: a recusa por publicação deixa de ir ao Relatório (o caso (ac) tem de ficar vermelho)", () => {
  assert.throws(() => verificarRelatorioDoPedido(trocaUnica(ler(ROTA_CICLO_PUB), RELATORIO_DO_PEDIDO_PUB, "")));
});

const ARRANQUE_NULO = [
  "if (scriptVivo) causa = causaDeRecusaPorScript(scriptVivo);",
  'else if (publicacaoOuResetEmCurso()) causa = "publicação ou reset Shopify em curso";',
  "await markMarginErosionCycleSkipped(shop, `ciclo parado: ${causa}`);",
];
function verificarArranqueNulo(texto) {
  const inicio = posicao(texto, "if (arranque === null) {", ROTA_CICLO_PUB);
  const fim = texto.indexOf("return;", inicio);
  for (const linha of ARRANQUE_NULO) {
    const pos = posicao(texto, linha, ROTA_CICLO_PUB);
    assert.ok(pos > inicio && pos < fim, `o arranque nulo tem de dizer a causa real, dentro do seu ramo: ${linha}`);
  }
}

await caso("(ad) ciclo: quando o arranque devolve null, o Relatório diz a causa (script, publicação ou reset)", () => {
  verificarArranqueNulo(ler(ROTA_CICLO_PUB));
});

await caso("mutação: sem a causa de script no arranque nulo (o caso (ad) tem de ficar vermelho)", () => {
  assert.throws(() => verificarArranqueNulo(trocaUnica(ler(ROTA_CICLO_PUB), ARRANQUE_NULO[0], "")));
});

function verificarSaltoLiberta(texto) {
  const inicio = posicao(texto, "if (decisao) {", ROTA_CICLO_PUB);
  const fim = texto.indexOf("} else {", inicio);
  assert.ok(fim > inicio, "o ramo de recusa tem de ter else");
  const ramo = texto.slice(inicio, fim);
  assert.ok(ramo.includes("reserva.libertar();"), "o salto tem de libertar a reserva");
  assert.match(ramo, /return;/, "o salto tem de parar o ciclo");
}

await caso("(ae) ciclo: o salto por confirmação liberta a reserva e para o ciclo", () => {
  verificarSaltoLiberta(ler(ROTA_CICLO_PUB));
});

await caso("mutação: o salto deixa a reserva presa (o caso (ae) tem de ficar vermelho)", () => {
  assert.throws(() =>
    verificarSaltoLiberta(
      trocaUnica(ler(ROTA_CICLO_PUB), "reserva.libertar();\n            console.log(`[trigger-sync] ciclo parado antes da publicação", "console.log(`[trigger-sync] ciclo parado antes da publicação")
    )
  );
});

function verificarConfirmacaoNaoLanca(texto) {
  const inicio = posicao(texto, "let decisao = null;", ROTA_CICLO_PUB);
  const fim = posicao(texto, "if (decisao) {", ROTA_CICLO_PUB);
  const bloco = texto.slice(inicio, fim);
  assert.match(bloco, /\} catch \(err\) \{/, "a confirmação tem de apanhar a exceção");
  assert.match(bloco, /causa: "não foi possível confirmar a indexação",/, "a exceção vira recusa com causa");
  assert.doesNotMatch(bloco, /throw/, "a exceção não pode voltar a sair");
}

await caso("(af) ciclo: a confirmação da indexação, se lançar, vira recusa com causa e não sai do IIFE", () => {
  verificarConfirmacaoNaoLanca(ler(ROTA_CICLO_PUB));
});

await caso("mutação: a causa da exceção desaparece (o caso (af) tem de ficar vermelho)", () => {
  assert.throws(() => verificarConfirmacaoNaoLanca(trocaUnica(ler(ROTA_CICLO_PUB), 'causa: "não foi possível confirmar a indexação",', 'causa: "",')));
});

await caso("(ag) causas curtas: cada marcador desconhecido e o script vivo dizem a sua causa, e o script ganha à indexação", () => {
  const casos = [
    ["leitura", "a.json (EACCES)", "marcador de atividade não lido (a.json (EACCES))"],
    ["ilegivel", "b.json", "marcador de atividade ilegível (b.json)"],
    ["sem_pid", "c.json", "marcador de script sem pid (c.json)"],
    ["pasta", "/d (EACCES)", "pasta de marcadores não lida (/d (EACCES))"],
  ];
  for (const [causa, motivo, esperada] of casos) {
    const decisao = atividade.decisaoDaPublicacaoManual({ indexacaoEmCurso: false, atividadeScript: { tipo: "desconhecida", causa, pid: null, motivo } });
    assert.equal(decisao.causa, esperada);
  }
  const script = { tipo: "script", causa: "script", pid: 1, motivo: "pid 1, desde x" };
  const daScript = "reindexação por script em curso (pid 1, desde x)";
  assert.equal(atividade.decisaoDaPublicacaoManual({ indexacaoEmCurso: false, atividadeScript: script }).causa, daScript);
  assert.equal(atividade.decisaoDaPublicacaoManual({ indexacaoEmCurso: true, atividadeScript: script }).causa, daScript, "o script ganha à indexação da app");
  assert.equal(atividade.decisaoDaPublicacaoManual({ indexacaoEmCurso: true, atividadeScript: null }).causa, "indexação em curso");
  assert.equal(atividade.decisaoDaPublicacaoManual({ indexacaoEmCurso: false, atividadeScript: null }), null);
});

await caso("mutação: uma causa curta trocada (o caso (ag) tem de ficar vermelho)", async () => {
  const m = mutanteDo("lib/curation/atividadeApp.js", "causa-trocada", (t) =>
    trocaUnica(t, '  leitura: "marcador de atividade não lido",', '  leitura: "marcador não lido",')
  );
  try {
    const mod = await import(pathToFileURL(m).href);
    const decisao = mod.decisaoDaPublicacaoManual({ indexacaoEmCurso: false, atividadeScript: { tipo: "desconhecida", causa: "leitura", pid: null, motivo: "a.json (EACCES)" } });
    assert.throws(() => assert.equal(decisao.causa, "marcador de atividade não lido (a.json (EACCES))"), "o caso (ag) tem de apanhar a causa trocada");
  } finally {
    fs.rmSync(m, { force: true });
  }
});

await caso("mutação: a indexação da app volta a ganhar ao script (o caso (ag) tem de ficar vermelho)", async () => {
  const m = mutanteDo("lib/curation/atividadeApp.js", "indexacao-ganha", (t) =>
    trocaUnica(t, "  if (atividadeScript) {\n    return { causa: causaDeRecusaPorScript(atividadeScript)", "  if (atividadeScript && !indexacaoEmCurso) {\n    return { causa: causaDeRecusaPorScript(atividadeScript)")
  );
  try {
    const mod = await import(pathToFileURL(m).href);
    const script = { tipo: "script", causa: "script", pid: 1, motivo: "pid 1, desde x" };
    const decisao = mod.decisaoDaPublicacaoManual({ indexacaoEmCurso: true, atividadeScript: script });
    assert.throws(() => assert.equal(decisao.causa, "reindexação por script em curso (pid 1, desde x)"), "o caso (ag) tem de apanhar a indexação a ganhar");
  } finally {
    fs.rmSync(m, { force: true });
  }
});

await caso("(ah) pasta de marcadores que não se lê: a guarda recusa (fail closed); uma pasta inexistente é só ausência", () => {
  const ficheiro = path.join(raiz, "nao-e-uma-pasta.txt");
  fs.writeFileSync(ficheiro, "x");
  try {
    const atv = atividade.scriptDeIndexacaoEmCurso({ dir: ficheiro });
    assert.equal(atv?.tipo, "desconhecida");
    assert.equal(atv?.causa, "pasta");
    assert.match(atividade.motivoDeRecusaPorScript(atv), /Pasta de marcadores de atividade não lida/);
  } finally {
    fs.rmSync(ficheiro, { force: true });
  }
  assert.equal(atividade.scriptDeIndexacaoEmCurso({ dir: path.join(raiz, "inexistente") }), null);
});

await caso("mutação: uma pasta que não se lê volta a passar (o caso (ah) tem de ficar vermelho)", async () => {
  const m = mutanteDo("lib/curation/atividadeApp.js", "pasta-passa", (t) =>
    trocaUnica(t, 'return { tipo: "desconhecida", causa: "pasta", pid: null, motivo: `${dir} (${err?.code || "erro"})` };', "return null;")
  );
  const ficheiro = path.join(raiz, "nao-e-uma-pasta-mut.txt");
  fs.writeFileSync(ficheiro, "x");
  try {
    const mod = await import(pathToFileURL(m).href);
    const atv = mod.scriptDeIndexacaoEmCurso({ dir: ficheiro });
    assert.throws(() => assert.equal(atv?.tipo, "desconhecida"), "o caso (ah) tem de apanhar a pasta que passa");
  } finally {
    fs.rmSync(ficheiro, { force: true });
    fs.rmSync(m, { force: true });
  }
});

/** Um marcador ilegível (nome que ordena primeiro) e um script vivo (outro processo, outro nome que ordena depois). */
function marcadoresDeIlegivelEScriptVivo() {
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const alheio = processoAlheio();
  const ilegivel = path.join(dir, "catalog-busy-indexacao-0-ilegivel.json");
  const vivo = path.join(dir, "catalog-busy-indexacao-9-script.json");
  fs.writeFileSync(ilegivel, "{ truncado", "utf8");
  fs.writeFileSync(vivo, JSON.stringify({ tipo: "indexacao", pid: alheio.pid, origem: "script", processo: "outro", startedAt: new Date().toISOString() }));
  return { alheio, ilegivel, vivo };
}
function largarMarcadoresDeIlegivelEScriptVivo({ alheio, ilegivel, vivo }) {
  alheio.kill();
  fs.rmSync(ilegivel, { force: true });
  fs.rmSync(vivo, { force: true });
}

await caso("(ai) um script vivo ganha a um marcador ilegível que vem antes na ordem dos nomes", () => {
  const marcas = marcadoresDeIlegivelEScriptVivo();
  try {
    assert.equal(atividade.scriptDeIndexacaoEmCurso()?.tipo, "script", "o script vivo tem de ganhar");
  } finally {
    largarMarcadoresDeIlegivelEScriptVivo(marcas);
  }
});

await caso("mutação: o marcador ilegível devolve-se primeiro (o caso (ai) tem de ficar vermelho)", async () => {
  const m = mutanteDo("lib/curation/atividadeApp.js", "ilegivel-primeiro", (t) =>
    trocaUnica(t, 'desconhecido = desconhecido || { tipo: "desconhecida", causa: "ilegivel", pid: null, motivo: ficheiro };\n      continue;', 'return { tipo: "desconhecida", causa: "ilegivel", pid: null, motivo: ficheiro };')
  );
  const marcas = marcadoresDeIlegivelEScriptVivo();
  try {
    const mod = await import(pathToFileURL(m).href);
    assert.throws(() => assert.equal(mod.scriptDeIndexacaoEmCurso()?.tipo, "script"), "o caso (ai) tem de apanhar o ilegível a ganhar");
  } finally {
    largarMarcadoresDeIlegivelEScriptVivo(marcas);
    fs.rmSync(m, { force: true });
  }
});

await caso("(aj) marcador de script de antes do arranque desta máquina não bloqueia (sobra de uma execução anterior)", () => {
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const alheio = processoAlheio();
  const sobra = path.join(dir, "catalog-busy-indexacao-1-sobra.json");
  fs.writeFileSync(sobra, JSON.stringify({ tipo: "indexacao", pid: alheio.pid, origem: "script", processo: "outro", startedAt: "2000-01-01T00:00:00.000Z" }));
  try {
    assert.equal(atividade.scriptDeIndexacaoEmCurso(), null);
  } finally {
    alheio.kill();
    fs.rmSync(sobra, { force: true });
  }
});

await caso("mutação: a sobra de antes do arranque volta a bloquear (o caso (aj) tem de ficar vermelho)", async () => {
  const m = mutanteDo("lib/curation/atividadeApp.js", "sobra-bloqueia", (t) =>
    trocaUnica(t, '    if (Number.isFinite(escritoEm) && escritoEm < arranque - 2000) continue;\n    if (!processoVivo(dados.pid)) continue;\n    return { tipo: "script"', '    if (!processoVivo(dados.pid)) continue;\n    return { tipo: "script"')
  );
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const alheio = processoAlheio();
  const sobra = path.join(dir, "catalog-busy-indexacao-1-sobra.json");
  fs.writeFileSync(sobra, JSON.stringify({ tipo: "indexacao", pid: alheio.pid, origem: "script", processo: "outro", startedAt: "2000-01-01T00:00:00.000Z" }));
  try {
    const mod = await import(pathToFileURL(m).href);
    assert.throws(() => assert.equal(mod.scriptDeIndexacaoEmCurso(), null), "o caso (aj) tem de apanhar a sobra que bloqueia");
  } finally {
    alheio.kill();
    fs.rmSync(sobra, { force: true });
    fs.rmSync(m, { force: true });
  }
});

await caso("(ak) marcador ilegível recente: a mensagem diz quando expira, e que só expira se a pasta deixar medir a idade", () => {
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const ficheiro = path.join(dir, "catalog-busy-indexacao-1-ilegivel-recente.json");
  fs.writeFileSync(ficheiro, "{ truncado", "utf8");
  try {
    const motivo = atividade.motivoDeRecusaPorScript(atividade.scriptDeIndexacaoEmCurso());
    assert.match(motivo, /Expira 10 min depois de escrito, se a pasta deixar medir a idade/);
    assert.match(motivo, /ou sem essa medida/);
  } finally {
    fs.rmSync(ficheiro, { force: true });
  }
});

await caso("mutação: a mensagem promete expiração sem a condição da sonda (o caso (ak) tem de ficar vermelho)", async () => {
  const m = mutanteDo("lib/curation/atividadeApp.js", "expira-sem-sonda", (t) =>
    trocaUnica(t, "Expira 10 min depois de escrito, se a pasta deixar medir a idade.", "Expira 10 min depois de escrito.")
  );
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const ficheiro = path.join(dir, "catalog-busy-indexacao-1-ilegivel-recente.json");
  fs.writeFileSync(ficheiro, "{ truncado", "utf8");
  try {
    const mod = await import(pathToFileURL(m).href);
    const motivo = mod.motivoDeRecusaPorScript(mod.scriptDeIndexacaoEmCurso());
    assert.throws(() => assert.match(motivo, /se a pasta deixar medir a idade/), "o caso (ak) tem de apanhar a mensagem sem a condição");
  } finally {
    fs.rmSync(ficheiro, { force: true });
    fs.rmSync(m, { force: true });
  }
});

/** Arranca a indexação com um marcador já escrito (ou uma pasta, com `pasta`) e devolve as linhas de erro do log. */
async function logDaRecusaComMarcador(modulo, nome, { pasta = false, conteudo = "{ truncado" } = {}) {
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const ficheiro = path.join(dir, nome);
  if (pasta) fs.mkdirSync(ficheiro);
  else fs.writeFileSync(ficheiro, conteudo, "utf8");
  const linhas = [];
  const original = console.error;
  console.error = (...args) => linhas.push(args.join(" "));
  try {
    assert.equal(await modulo.startCatalogIndexingWorker(SHOP, {}, { causa: "ciclo" }), null);
  } finally {
    console.error = original;
    fs.rmSync(ficheiro, { recursive: true, force: true });
  }
  return linhas;
}

await caso("(al) o arranque recusado grava no log a causa real do marcador (ilegivel, não script)", async () => {
  const linhas = await logDaRecusaComMarcador(indexacao, "catalog-busy-indexacao-1-truncado.json");
  assert.ok(linhas.some((l) => l.includes("causa=ilegivel")), `o log tem de dizer causa=ilegivel: ${linhas.join(" | ")}`);
  assert.ok(!linhas.some((l) => l.includes("causa=script")), "a causa não pode ser script");
});

await caso("mutação: o log diz marcador_ilegivel para qualquer causa (o caso (al) tem de ficar vermelho)", async () => {
  const m = mutanteDo("lib/importer/catalog/indexingStream.server.js", "causa-no-log", (t) =>
    trocaUnica(t, 'const causa = atividadeScript.causa || "marcador_ilegivel";', 'const causa = atividadeScript.tipo === "script" ? "script" : "marcador_ilegivel";')
  );
  try {
    const mod = await import(pathToFileURL(m).href);
    const linhas = await logDaRecusaComMarcador(mod, "catalog-busy-indexacao-1-truncado.json");
    assert.throws(() => assert.ok(linhas.some((l) => l.includes("causa=ilegivel"))), "o caso (al) tem de apanhar o rótulo errado");
  } finally {
    fs.rmSync(m, { force: true });
  }
});

const MENSAGEM_DA_RESERVA_OCUPADA = "Já há uma publicação ou um reset Shopify em curso. Aguarda que termine antes de publicar.";
await caso("(am) publicação manual: com a reserva ocupada por reset ou publicação, a mensagem diz isso e não fala de sincronização", () => {
  assert.ok(ler(ROTA_PUBLICACAO).includes(MENSAGEM_DA_RESERVA_OCUPADA));
});

await caso("mutação: a mensagem volta a dizer sincronização (o caso (am) tem de ficar vermelho)", () => {
  assert.throws(() =>
    assert.ok(trocaUnica(ler(ROTA_PUBLICACAO), MENSAGEM_DA_RESERVA_OCUPADA, "Já existe uma sincronização Shopify em curso.").includes(MENSAGEM_DA_RESERVA_OCUPADA))
  );
});

await caso("(al2) marcador de leitura (uma pasta com nome de ficheiro) recusa o arranque com causa=leitura no log", async () => {
  const linhas = await logDaRecusaComMarcador(indexacao, "catalog-busy-indexacao-1-dirlido.json", { pasta: true });
  assert.ok(linhas.some((l) => l.includes("causa=leitura")), `o log tem de dizer causa=leitura: ${linhas.join(" | ")}`);
});

await caso("(al3) marcador de script sem pid recusa o arranque com causa=sem_pid no log", async () => {
  const conteudo = JSON.stringify({ tipo: "indexacao", origem: "script", startedAt: new Date().toISOString() });
  const linhas = await logDaRecusaComMarcador(indexacao, "catalog-busy-indexacao-1-sempid.json", { conteudo });
  assert.ok(linhas.some((l) => l.includes("causa=sem_pid")), `o log tem de dizer causa=sem_pid: ${linhas.join(" | ")}`);
});

await caso("(al4) pasta de marcadores que não se lê recusa o arranque com causa=pasta no log", async () => {
  const ficheiro = path.join(raiz, "pasta-do-log.txt");
  fs.writeFileSync(ficheiro, "x");
  const anterior = process.env.CURATION_DATA_DIR;
  process.env.CURATION_DATA_DIR = ficheiro;
  const linhas = [];
  const original = console.error;
  console.error = (...args) => linhas.push(args.join(" "));
  try {
    assert.equal(await indexacao.startCatalogIndexingWorker(SHOP, {}, { causa: "ciclo" }), null);
  } finally {
    console.error = original;
    if (anterior === undefined) delete process.env.CURATION_DATA_DIR;
    else process.env.CURATION_DATA_DIR = anterior;
    fs.rmSync(ficheiro, { force: true });
  }
  assert.ok(linhas.some((l) => l.includes("causa=pasta")), `o log tem de dizer causa=pasta: ${linhas.join(" | ")}`);
});

await caso("(an) pasta de marcadores que não se lê: a app devolve a causa e não lança (reset e publicação)", () => {
  const ficheiro = path.join(raiz, "pasta-nao-lida.txt");
  fs.writeFileSync(ficheiro, "x");
  try {
    const atv = atividade.atividadeAppEmCurso({ dir: ficheiro });
    assert.equal(atv?.tipo, "desconhecida", "uma pasta que não se lê é desconhecida, e não lança");
    assert.match(atv.motivo, /ENOTDIR/);
    assert.match(atividade.motivoDeRecusaDoReset({ indexacaoEmCurso: false, atividade: atv }), /Atividade da app ilegível/);
    const decisao = atividade.decisaoDaPublicacaoManual({
      indexacaoEmCurso: false,
      atividadeScript: atividade.scriptDeIndexacaoEmCurso({ dir: ficheiro }),
    });
    assert.match(decisao?.mensagem ?? "", /Pasta de marcadores de atividade não lida/);
  } finally {
    fs.rmSync(ficheiro, { force: true });
  }
});

await caso("mutação: a app volta a lançar com a pasta que não se lê (o caso (an) tem de ficar vermelho)", async () => {
  const m = mutanteDo("lib/curation/atividadeApp.js", "pasta-lanca", (t) =>
    trocaUnica(t, '    return { tipo: "desconhecida", pid: null, motivo: `${dir} (${err?.code || "erro"})` };\n  }\n  // Um marcador escrito antes', "    throw err;\n  }\n  // Um marcador escrito antes")
  );
  const ficheiro = path.join(raiz, "pasta-nao-lida-mut.txt");
  fs.writeFileSync(ficheiro, "x");
  try {
    const mod = await import(pathToFileURL(m).href);
    assert.throws(() => assert.equal(mod.atividadeAppEmCurso({ dir: ficheiro })?.tipo, "desconhecida"), "o caso (an) tem de apanhar a exceção");
  } finally {
    fs.rmSync(ficheiro, { force: true });
    fs.rmSync(m, { force: true });
  }
});

await caso("(ao) a recusa por script vivo diz a hora de Lisboa, não o ISO em UTC", () => {
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const alheio = processoAlheio();
  const vivo = path.join(dir, "catalog-busy-indexacao-9-hora.json");
  fs.writeFileSync(vivo, JSON.stringify({ tipo: "indexacao", pid: alheio.pid, origem: "script", processo: "outro", startedAt: "2026-10-18T03:49:22.861Z" }));
  try {
    const motivo = atividade.motivoDeRecusaPorScript(atividade.scriptDeIndexacaoEmCurso());
    assert.doesNotMatch(motivo, /2026-10-18T03:49:22\.861Z/, "não pode sair o ISO em UTC");
    assert.match(motivo, /04:49:22/, "a hora tem de sair em Lisboa (UTC+1 em outubro)");
  } finally {
    alheio.kill();
    fs.rmSync(vivo, { force: true });
  }
});

await caso("mutação: a hora sai em UTC (o caso (ao) tem de ficar vermelho)", async () => {
  const m = mutanteDo("lib/curation/atividadeApp.js", "hora-utc", (t) =>
    trocaUnica(t, "motivo: `pid ${dados.pid}, desde ${horaDeLisboa(dados.startedAt)}` };", "motivo: `pid ${dados.pid}, desde ${dados.startedAt}` };")
  );
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const alheio = processoAlheio();
  const vivo = path.join(dir, "catalog-busy-indexacao-9-hora.json");
  fs.writeFileSync(vivo, JSON.stringify({ tipo: "indexacao", pid: alheio.pid, origem: "script", processo: "outro", startedAt: "2026-10-18T03:49:22.861Z" }));
  try {
    const mod = await import(pathToFileURL(m).href);
    const motivo = mod.motivoDeRecusaPorScript(mod.scriptDeIndexacaoEmCurso());
    assert.throws(() => assert.match(motivo, /04:49:22/), "o caso (ao) tem de apanhar a hora em UTC");
  } finally {
    alheio.kill();
    fs.rmSync(vivo, { force: true });
    fs.rmSync(m, { force: true });
  }
});

await caso("mutação: a sessão Shopify inválida do reset deixa a reserva presa (o caso do reset tem de ficar vermelho)", () => {
  assert.throws(() => verificarLibertacaoNosCaminhosDeErro(trocaUnica(ler(ROTA_RESET), "reserva.libertar();\n    const message =", "const message =")));
});

await caso("(u) uma escrita de marca que falha não deixa ficheiro parcial (que bloquearia 10 min)", () => {
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const original = fs.writeFileSync;
  fs.writeFileSync = (ficheiro, conteudo, opcoes) => {
    if (String(ficheiro).includes("catalog-busy-")) {
      original(ficheiro, "{ parcial", opcoes);
      throw new Error("disco cheio");
    }
    return original(ficheiro, conteudo, opcoes);
  };
  try {
    assert.throws(() => atividade.marcarAtividadeApp({ tipo: "indexacao" }), /disco cheio/);
  } finally {
    fs.writeFileSync = original;
  }
  assert.equal(marcadoresDeIndexacao().length, 0, "a escrita falhada não pode deixar marca");
  assert.equal(atividade.scriptDeIndexacaoEmCurso(), null, "nem marca ilegível que bloqueie");
});

await caso("mutação: uma escrita de marca falhada deixa ficheiro parcial (o caso (u) tem de ficar vermelho)", async () => {
  const m = mutanteDo("lib/curation/atividadeApp.js", "marca-parcial", (t) =>
    trocaUnica(t, "    try {\n      fs.rmSync(ficheiro, { force: true });\n    } catch {\n      /* sem remoção */\n    }\n    throw err;", "    throw err;")
  );
  limparMarcadores();
  const dir = dados.resolveCurationDataDir();
  const original = fs.writeFileSync;
  fs.writeFileSync = (ficheiro, conteudo, opcoes) => {
    if (String(ficheiro).includes("catalog-busy-")) {
      original(ficheiro, "{ parcial", opcoes);
      throw new Error("disco cheio");
    }
    return original(ficheiro, conteudo, opcoes);
  };
  try {
    const mod = await import(pathToFileURL(m).href);
    assert.throws(() => mod.marcarAtividadeApp({ tipo: "indexacao" }), /disco cheio/);
    assert.throws(() => assert.equal(marcadoresDeIndexacao().length, 0), "o caso (u) tem de apanhar a mutação");
  } finally {
    fs.writeFileSync = original;
    limparMarcadores();
    fs.rmSync(m, { force: true });
  }
});

await caso("(v) a purga só conta como concluída com done: marca falhada resolve false", async () => {
  limparMarcadores();
  const original = fs.writeFileSync;
  fs.writeFileSync = (ficheiro, conteudo, opcoes) => {
    if (String(ficheiro).includes("catalog-busy-")) throw new Error("sem marca");
    return original(ficheiro, conteudo, opcoes);
  };
  try {
    const concluiu = await indexacao.startCatalogCleanupInBackground("loja-marca-falhada.myshopify.com", {}, { causa: "script" });
    assert.equal(concluiu, false, "uma corrida que não arrancou não é concluída");
  } finally {
    fs.writeFileSync = original;
  }
});

await caso("mutação: resolver em closed sem olhar a done faz o caso (v) ficar vermelho", async () => {
  const m = mutanteDo("lib/importer/catalog/indexingStream.server.js", "closed-sem-done", (t) =>
    trocaUnica(t, "      resolve(concluiu);", "      resolve(true);")
  );
  limparMarcadores();
  const original = fs.writeFileSync;
  fs.writeFileSync = (ficheiro, conteudo, opcoes) => {
    if (String(ficheiro).includes("catalog-busy-")) throw new Error("sem marca");
    return original(ficheiro, conteudo, opcoes);
  };
  try {
    const mod = await import(pathToFileURL(m).href);
    const concluiu = await mod.startCatalogCleanupInBackground("loja-marca-mutante.myshopify.com", {}, { causa: "script" });
    assert.equal(concluiu, true, "a mutação resolve true sem concluir, e o caso (v) tem de apanhar isso");
  } finally {
    fs.writeFileSync = original;
    fs.rmSync(m, { force: true });
  }
});

await caso("(w) o ciclo para com motivo na confirmação, e a confirmação não lança", () => {
  verificarCicloParaComConfirmacao(ler(ROTA_CICLO_PUB));
});

await caso("mutação: o ciclo segue sem parar quando há motivo (o caso (w) tem de ficar vermelho)", () => {
  assert.throws(() =>
    verificarCicloParaComConfirmacao(trocaUnica(ler(ROTA_CICLO_PUB), "            return;\n          } else {", "          } else {"))
  );
});

if (falhas) {
  console.error(`\ndbg140-141-guardas: ${falhas} verificação(ões) falharam`);
  process.exit(1);
}
console.log("\ndbg140-141-guardas: todos os casos passaram");
