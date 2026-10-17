#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-154 e DBG-157 (PR 2). Sem Fly nem BD reais: PROJECT_ROOT e CURATION_DATA_DIR em diretórios temporários,
 * fork falso, e processos filhos para a escrita entre processos.
 *   (a) DBG-154: escritas do estado com lock entre processos. Quatro processos a escrever o mesmo ficheiro não
 *       perdem chaves. Mutação: sem lock e com uma janela na leitura-escrita tem de perder chaves.
 *   (b) DBG-154: um flush que falha devolve false. Um ficheiro truncado não é substituído por um objeto sem state.
 *       Mutação: sem a recusa, o objeto sem state entra no disco e o teste fica vermelho.
 *   (c) DBG-154: check-no-indexing sai com 2 para um objeto sem state nem indexing. Mutação: sem a verificação, sai com 0.
 *   (d) DBG-154: o fim da corrida não se anuncia como concluído se o flush falhar. Mutação: ignorar o resultado.
 *   (e) DBG-157: dois arranques no mesmo tick dão um só fork. Mutação: sem a reserva, dão dois.
 *   (f) DBG-157: uma falha no flush do arranque não faz fork, e liberta a reserva. Mutação: sem libertar, o arranque
 *       seguinte fica preso ao resultado antigo.
 * Uso: node scripts/tests/dbg154-157-estado.test.js
 */
import "./_isolate-curation.js";

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "dbg154-157-"));
process.on("exit", () => fs.rmSync(raiz, { recursive: true, force: true }));

// Antes de importar os módulos: o config lê PROJECT_ROOT ao carregar.
process.env.PROJECT_ROOT = raiz;

const modulo = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);
const estado = await modulo("lib/importer/catalog/catalogRebuildStatus.server.js");
const indexacao = await modulo("lib/importer/catalog/indexingStream.server.js");

const DIR_INDEX = path.join(raiz, "data", "catalog-index");
const SHOP = "loja-estado.myshopify.com";
const ficheiroDoEstado = (shop) => path.join(DIR_INDEX, `${shop.replace(/\//g, "_")}-rebuild-status.json`);
/** Ocupa o diretório de estado com um ficheiro: o mkdir e o lock falham, e o flush devolve false. */
function bloquearEscrita() {
  fs.rmSync(DIR_INDEX, { recursive: true, force: true });
  fs.writeFileSync(DIR_INDEX, "bloqueado");
}
function desbloquearEscrita() {
  fs.rmSync(DIR_INDEX, { recursive: true, force: true });
}

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

/** Cópia de um módulo com um trecho trocado, no mesmo diretório (os imports relativos continuam válidos). */
function mutante(relativo, nome, antigo, novo) {
  const origem = path.join(RAIZ, relativo);
  const texto = fs.readFileSync(origem, "utf8");
  if (texto.split(antigo).length - 1 !== 1) throw new Error(`mutação ${nome}: o trecho tem de existir uma vez`);
  const destino = path.join(path.dirname(origem), `.mutante-${nome}-${process.pid}.mjs`);
  fs.writeFileSync(destino, texto.replace(antigo, () => novo));
  return { caminho: destino, apagar: () => fs.rmSync(destino, { force: true }) };
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

// ---------- (a) DBG-154: escritas entre processos ----------
const N_PROCESSOS = 4;
const N_ESCRITAS = 40;

/** Corre N_PROCESSOS filhos; cada um grava N_ESCRITAS chaves próprias no mesmo ficheiro. */
async function escreverEmParalelo(moduloCaminho, shop) {
  const script = `
    const m = await import(process.env.MOD);
    for (let i = 0; i < ${N_ESCRITAS}; i += 1) {
      m.setInMemoryStatus(process.env.SHOP, { state: "running", ["k_" + process.env.ID + "_" + i]: i });
      await m.flushCatalogRebuildStatus(process.env.SHOP, {});
    }`;
  const filhos = Array.from({ length: N_PROCESSOS }, (_, id) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, PROJECT_ROOT: raiz, MOD: moduloCaminho, SHOP: shop, ID: String(id) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let erro = "";
    p.stderr.on("data", (d) => (erro += d));
    p.on("exit", (codigo) => (codigo === 0 ? resolve() : reject(new Error(`filho saiu com ${codigo}: ${erro}`))));
  }));
  await Promise.all(filhos);
  const lido = JSON.parse(fs.readFileSync(ficheiroDoEstado(shop), "utf8"));
  return Object.keys(lido).filter((k) => k.startsWith("k_")).length;
}

const ESPERADO = N_PROCESSOS * N_ESCRITAS;
const LOCK_ESTADO = path.join(RAIZ, "lib/importer/catalog/catalogRebuildStatus.server.js");

console.log("(a) DBG-154: escritas entre processos com lock");
await caso("quatro processos a escrever o mesmo estado não perdem chaves", async () => {
  const perdidas = ESPERADO - (await escreverEmParalelo(LOCK_ESTADO, SHOP));
  assert.equal(perdidas, 0, `chaves perdidas: ${perdidas}`);
  assert.equal(fs.existsSync(`${ficheiroDoEstado(SHOP)}.lock`), false, "o lock tem de ser libertado no fim");
});
await caso("mutação: sem lock e com uma janela na leitura-escrita perde chaves (o caso acima tem de ficar vermelho)", async () => {
  // Lock trocado por um titular falso, e uma pausa entre ler o ficheiro e escrevê-lo. A pausa só aumenta a
  // janela da corrida: em produção não existe.
  const m = mutante(
    "lib/importer/catalog/catalogRebuildStatus.server.js",
    "sem-lock",
    "    titular = await adquirirLockDoFicheiro(`${ficheiro}.lock`, { prazoMs: PRAZO_LOCK_ESTADO_MS });",
    '    titular = { lockPath: `${ficheiro}.lock`, token: "sem-lock", timer: null, renovando: null, perdido: false };'
  );
  try {
    fs.rmSync(DIR_INDEX, { recursive: true, force: true });
    const texto = fs.readFileSync(m.caminho, "utf8")
      .replace("    if (!(await titularAindaTemLock(titular))) {", "    if (false) {")
      .replace("    const novo = { ...(await lerEstadoParaEscrita(ficheiro)), ...atualizacao };",
        "    const lido = await lerEstadoParaEscrita(ficheiro);\n    await new Promise((r) => setTimeout(r, 3));\n    const novo = { ...lido, ...atualizacao };");
    fs.writeFileSync(m.caminho, texto);
    const mutado = await modulo(path.relative(RAIZ, m.caminho));
    assert.ok(mutado, "o mutante carrega");
    const perdidas = ESPERADO - (await escreverEmParalelo(m.caminho, `${SHOP}.mut`));
    assert.ok(perdidas > 0, "o mutante tem de perder chaves, como o código antigo");
    assert.throws(() => assert.equal(perdidas, 0));
  } finally {
    m.apagar();
  }
});

// ---------- (b) DBG-154: flush com resultado, e nenhum objeto sem state ----------
console.log("(b) DBG-154: flush com resultado");
await caso("flush com a escrita bloqueada devolve false e não lança", async () => {
  bloquearEscrita();
  const ok = await estado.flushCatalogRebuildStatus(SHOP, { state: "completed" });
  assert.equal(ok, false);
  desbloquearEscrita();
});
await caso("flush normal devolve true e o lock é libertado", async () => {
  const ok = await estado.flushCatalogRebuildStatus(SHOP, { state: "completed", totalRows: 7 });
  assert.equal(ok, true);
  assert.equal(JSON.parse(fs.readFileSync(ficheiroDoEstado(SHOP), "utf8")).totalRows, 7);
  assert.equal(fs.existsSync(`${ficheiroDoEstado(SHOP)}.lock`), false);
});
const SHOP_TRUNCADO = "loja-truncado.myshopify.com";
const TRUNCADO = '{"state":"runn';
/** Verificação: um ficheiro truncado não é trocado por um objeto sem state (o portão leria isso como livre). */
async function escritaSemEstadoNaoSubstituiTruncado(shop) {
  fs.mkdirSync(DIR_INDEX, { recursive: true });
  fs.writeFileSync(ficheiroDoEstado(shop), TRUNCADO);
  estado.clearInMemoryStatus(shop);
  const ok = await estado.flushCatalogRebuildStatus(shop, { totalRows: 5 });
  assert.equal(ok, false, "sem state nem indexing, a escrita tem de ser recusada");
  assert.equal(fs.readFileSync(ficheiroDoEstado(shop), "utf8"), TRUNCADO, "o ficheiro truncado fica como estava");
}
await caso("ficheiro truncado: escrita sem state não o substitui por um objeto vazio", () =>
  escritaSemEstadoNaoSubstituiTruncado(SHOP_TRUNCADO));
await caso("ficheiro truncado: escrita com state repara-o", async () => {
  fs.mkdirSync(DIR_INDEX, { recursive: true });
  fs.writeFileSync(ficheiroDoEstado(`${SHOP_TRUNCADO}.reparo`), TRUNCADO);
  estado.clearInMemoryStatus(`${SHOP_TRUNCADO}.reparo`);
  const ok = await estado.flushCatalogRebuildStatus(`${SHOP_TRUNCADO}.reparo`, { state: "failed", indexing: false });
  assert.equal(ok, true);
  assert.equal(JSON.parse(fs.readFileSync(ficheiroDoEstado(`${SHOP_TRUNCADO}.reparo`), "utf8")).state, "failed");
});
await caso("mutação: sem a recusa, o objeto sem state entra no disco (a verificação acima tem de ficar vermelha)", async () => {
  const m = mutante(
    "lib/importer/catalog/catalogRebuildStatus.server.js",
    "sem-recusa",
    "    if (novo.state === undefined && novo.indexing === undefined) {",
    "    if (false) {"
  );
  try {
    const mutado = await modulo(path.relative(RAIZ, m.caminho));
    const shop = `${SHOP_TRUNCADO}.mut`;
    fs.mkdirSync(DIR_INDEX, { recursive: true });
    fs.writeFileSync(ficheiroDoEstado(shop), TRUNCADO);
    mutado.clearInMemoryStatus(shop);
    const ok = await mutado.flushCatalogRebuildStatus(shop, { totalRows: 5 });
    assert.equal(ok, true, "o mutante tem de gravar, como o código antigo");
    assert.throws(() => assert.equal(ok, false));
  } finally {
    m.apagar();
  }
});

// ---------- (c) DBG-154: check-no-indexing ----------
console.log("(c) DBG-154: check-no-indexing e objetos sem state");
const CHECK = path.join(RAIZ, "scripts/maintenance/check-no-indexing.mjs");
const SHOP_CHECK = "loja-check.myshopify.com";
function correrCheck(conteudo, scriptCaminho = CHECK) {
  const dados = fs.mkdtempSync(path.join(raiz, "check-"));
  fs.mkdirSync(path.join(dados, "catalog-index"), { recursive: true });
  fs.writeFileSync(path.join(dados, "catalog-index", `${SHOP_CHECK}-rebuild-status.json`), conteudo);
  return spawnSync(process.execPath, [scriptCaminho, "--shop", SHOP_CHECK, "--data-dir", dados], { encoding: "utf8" }).status;
}
await caso("objeto sem state nem indexing sai com 2, como o JSON ilegível", () => {
  for (const conteudo of ["{}", "[]", '{"totalRows":5}']) {
    assert.equal(correrCheck(conteudo), 2, `conteúdo ${conteudo}`);
  }
});
await caso("objeto com state ou indexing continua a sair com 0 quando não há corrida", () => {
  assert.equal(correrCheck('{"state":"completed"}'), 0);
  assert.equal(correrCheck('{"indexing":false}'), 0);
});
await caso("mutação: sem a verificação, o objeto sem state sai com 0 (o caso acima tem de ficar vermelho)", () => {
  const m = mutante(
    "scripts/maintenance/check-no-indexing.mjs",
    "sem-verificacao",
    'if (!status || typeof status !== "object" || Array.isArray(status) || (status.state === undefined && status.indexing === undefined)) {',
    "if (false) {"
  );
  try {
    assert.equal(correrCheck("{}", m.caminho), 0, "o mutante tem de sair com 0, como o código antigo");
    assert.throws(() => assert.equal(correrCheck("{}", m.caminho), 2));
  } finally {
    m.apagar();
  }
});

// ---------- (d) DBG-154: o fim da corrida depende do flush ----------
console.log("(d) DBG-154: fim da corrida e resultado do flush");
/** Arranca com a escrita a funcionar, bloqueia-a antes do `done` e devolve os eventos emitidos. */
async function terminarComFlush(ind, shop, { bloquear }) {
  const filhos = [];
  ind.definirForkParaTestes(() => {
    const c = new FakeChild();
    filhos.push(c);
    return c;
  });
  const eventos = [];
  const parar = ind.subscribeIndexingEvents(shop, (e) => eventos.push(e));
  try {
    await ind.startCatalogIndexingWorker(shop, {}, { causa: "script" });
    if (bloquear) bloquearEscrita();
    filhos[0].emit("message", { type: "done", indexed: 3, scanned: 3 });
    await esperarAte(() => eventos.some((e) => e.type === "closed"));
    return eventos;
  } finally {
    if (bloquear) desbloquearEscrita();
    if (typeof parar === "function") parar();
    ind.definirForkParaTestes(null);
  }
}
await caso("controlo: com a escrita a funcionar, o fim anuncia-se como concluído", async () => {
  const eventos = await terminarComFlush(indexacao, "loja-fim-ok.myshopify.com", { bloquear: false });
  assert.ok(eventos.some((e) => e.type === "done"), "tem de haver done");
});
await caso("flush do fim com erro: não se anuncia done, anuncia-se erro e a indexação fecha", async () => {
  const eventos = await terminarComFlush(indexacao, "loja-fim-falha.myshopify.com", { bloquear: true });
  assert.equal(eventos.some((e) => e.type === "done"), false, "não pode dizer concluído sem o estado no disco");
  assert.ok(eventos.some((e) => e.type === "error"), "tem de anunciar erro");
  assert.equal(indexacao.isCatalogIndexingRunning("loja-fim-falha.myshopify.com"), false);
});
await caso("mutação: ignorar o resultado do flush deixa anunciar done (o caso acima tem de ficar vermelho)", async () => {
  const m = mutante(
    "lib/importer/catalog/indexingStream.server.js",
    "sem-fim",
    "    if (!gravado) {",
    "    if (false) {"
  );
  try {
    const mutado = await modulo(path.relative(RAIZ, m.caminho));
    const eventos = await terminarComFlush(mutado, "loja-fim-mut.myshopify.com", { bloquear: true });
    assert.ok(eventos.some((e) => e.type === "done"), "o mutante tem de anunciar done, como o código antigo");
    assert.throws(() => assert.equal(eventos.some((e) => e.type === "done"), false));
  } finally {
    m.apagar();
  }
});

// ---------- (e) DBG-157: reserva no arranque ----------
console.log("(e) DBG-157: reserva síncrona no arranque");
await caso("dois arranques no mesmo tick dão um só fork e a mesma promessa", async () => {
  let forks = 0;
  indexacao.definirForkParaTestes(() => {
    forks += 1;
    return new FakeChild();
  });
  try {
    const p1 = indexacao.startCatalogIndexingWorker("loja-tick.myshopify.com", {}, { causa: "script" });
    const p2 = indexacao.startCatalogIndexingWorker("loja-tick.myshopify.com", {}, { causa: "script" });
    assert.equal(p1, p2, "o segundo arranque tem de receber a mesma promessa");
    await Promise.all([p1, p2]);
    assert.equal(forks, 1, "tem de haver um só fork");
  } finally {
    indexacao.definirForkParaTestes(null);
  }
});
await caso("mutação: sem a reserva, dois arranques no mesmo tick fazem dois forks (o caso acima tem de ficar vermelho)", async () => {
  const m = mutante(
    "lib/importer/catalog/indexingStream.server.js",
    "sem-reserva",
    "  if (arranquesEmCurso.has(shop)) return arranquesEmCurso.get(shop);",
    ""
  );
  try {
    const mutado = await modulo(path.relative(RAIZ, m.caminho));
    let forks = 0;
    mutado.definirForkParaTestes(() => {
      forks += 1;
      return new FakeChild();
    });
    const p1 = mutado.startCatalogIndexingWorker("loja-tick-mut.myshopify.com", {}, { causa: "script" });
    const p2 = mutado.startCatalogIndexingWorker("loja-tick-mut.myshopify.com", {}, { causa: "script" });
    await Promise.all([p1, p2]);
    assert.equal(forks, 2, "o mutante tem de fazer dois forks, como o código antigo");
    assert.throws(() => assert.equal(forks, 1));
  } finally {
    m.apagar();
  }
});

// ---------- (f) DBG-157: falha no flush do arranque ----------
console.log("(f) DBG-157: falha no flush do arranque");
await caso("flush do arranque com erro: não há fork, o arranque devolve null, e a reserva é libertada", async () => {
  let forks = 0;
  indexacao.definirForkParaTestes(() => {
    forks += 1;
    return new FakeChild();
  });
  const shop = "loja-arranque-falha.myshopify.com";
  try {
    bloquearEscrita();
    const r1 = await indexacao.startCatalogIndexingWorker(shop, {}, { causa: "script" });
    assert.equal(r1, null, "sem estado no disco, o arranque não se faz");
    assert.equal(forks, 0, "sem estado no disco, não pode haver fork");
    desbloquearEscrita();
    const r2 = await indexacao.startCatalogIndexingWorker(shop, {}, { causa: "script" });
    assert.notEqual(r2, null, "a reserva tem de estar libertada: o arranque seguinte faz-se");
    assert.equal(forks, 1);
  } finally {
    desbloquearEscrita();
    indexacao.definirForkParaTestes(null);
  }
});
await caso("mutação: sem libertar a reserva, o arranque seguinte fica preso ao resultado antigo (o caso acima tem de ficar vermelho)", async () => {
  const m = mutante(
    "lib/importer/catalog/indexingStream.server.js",
    "sem-libertar",
    "  const arranque = arrancarWorker(shop, settings, opts).finally(() => arranquesEmCurso.delete(shop));",
    "  const arranque = arrancarWorker(shop, settings, opts);"
  );
  try {
    const mutado = await modulo(path.relative(RAIZ, m.caminho));
    let forks = 0;
    mutado.definirForkParaTestes(() => {
      forks += 1;
      return new FakeChild();
    });
    const shop = "loja-arranque-falha-mut.myshopify.com";
    bloquearEscrita();
    await mutado.startCatalogIndexingWorker(shop, {}, { causa: "script" });
    desbloquearEscrita();
    const r2 = await mutado.startCatalogIndexingWorker(shop, {}, { causa: "script" });
    assert.equal(r2, null, "o mutante tem de devolver o resultado antigo, como o código antigo");
    assert.throws(() => assert.notEqual(r2, null));
  } finally {
    desbloquearEscrita();
    m.apagar();
  }
});

if (falhas) {
  console.error(`\ndbg154-157-estado: ${falhas} verificação(ões) falharam`);
  process.exit(1);
}
console.log("\ndbg154-157-estado: todos os casos passaram");
