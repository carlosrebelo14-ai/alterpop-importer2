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

let contadorBarreira = 0;

/**
 * Corre N_PROCESSOS filhos; cada um grava N_ESCRITAS chaves próprias no mesmo ficheiro. Os filhos só começam a
 * escrever quando todos estão carregados (barreira por ficheiro). Sem isto, um filho pode acabar antes de outro
 * começar, não há sobreposição, e a mutação sem lock passa sem perder chaves (corrida de tempo, não de código).
 */
/** Prazo de cada filho (PR 5, revisão). Um filho que não fica pronto, ou não sai, em prazo é morto e a escrita falha. */
const PRAZO_DO_FILHO_MS = 60_000;

async function escreverEmParalelo(moduloCaminho, shop, { prazoMs = PRAZO_DO_FILHO_MS, semPronto = false } = {}) {
  const barreira = path.join(raiz, `barreira-${contadorBarreira++}`);
  const script = `
    import fs from "node:fs";
    const m = await import(process.env.MOD);
    if (process.env.SEM_PRONTO !== "1") process.stdout.write("pronto\\n");
    while (!fs.existsSync(process.env.BARREIRA)) await new Promise((r) => setTimeout(r, 1));
    for (let i = 0; i < ${N_ESCRITAS}; i += 1) {
      m.setInMemoryStatus(process.env.SHOP, { state: "running", ["k_" + process.env.ID + "_" + i]: i });
      await m.flushCatalogRebuildStatus(process.env.SHOP, {});
    }`;
  const processos = [];
  const filhos = Array.from({ length: N_PROCESSOS }, (_, id) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, PROJECT_ROOT: raiz, MOD: moduloCaminho, SHOP: shop, ID: String(id), BARREIRA: barreira, SEM_PRONTO: semPronto ? "1" : "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    processos.push(p);
    let erro = "";
    let saida = "";
    const prazo = setTimeout(() => {
      p.kill();
      reject(new Error(`filho ${id} não ficou pronto em ${prazoMs} ms`));
    }, prazoMs);
    p.stdout.on("data", (d) => {
      saida += d;
      if (saida.includes("pronto")) {
        clearTimeout(prazo);
        resolve(p);
      }
    });
    p.stderr.on("data", (d) => (erro += d));
    p.on("exit", (codigo) => {
      clearTimeout(prazo);
      if (codigo !== 0) reject(new Error(`filho saiu com ${codigo}: ${erro}`));
    });
  }));
  let prontos;
  try {
    prontos = await Promise.all(filhos);
  } catch (err) {
    // Um filho que falha deixa os irmãos à espera da barreira. Matam-se todos, para o teste não ficar pendurado.
    for (const p of processos) p.kill();
    throw err;
  }
  fs.writeFileSync(barreira, "");
  await Promise.all(prontos.map((p) => new Promise((resolve, reject) => {
    const prazo = setTimeout(() => {
      p.kill();
      reject(new Error(`filho não saiu em ${prazoMs} ms`));
    }, prazoMs);
    p.on("exit", (codigo) => {
      clearTimeout(prazo);
      if (codigo === 0) resolve();
      else reject(new Error(`filho saiu com ${codigo}`));
    });
    if (p.exitCode !== null) {
      clearTimeout(prazo);
      resolve();
    }
  })));
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

await caso("barreira com prazo: um filho que nunca fica pronto faz a escrita falhar em prazo", async () => {
  await assert.rejects(escreverEmParalelo(LOCK_ESTADO, SHOP, { prazoMs: 1500, semPronto: true }), /não ficou pronto em 1500 ms/);
});
await caso("mutação: sem lock e com uma janela na leitura-escrita perde chaves (o caso acima tem de ficar vermelho)", async () => {
  // Lock trocado por um titular falso, e uma pausa entre ler o ficheiro e escrevê-lo. A pausa só aumenta a
  // janela da corrida: em produção não existe.
  const m = mutanteVarios("lib/importer/catalog/catalogRebuildStatus.server.js", "sem-lock", [
    [
      "    titular = await adquirirLockDoFicheiro(`${ficheiro}.lock`, {\n      prazoMs: PRAZO_LOCK_ESTADO_MS,\n      rotulo: \"[estado] espera esgotada: estado da indexação ocupado\",\n    });",
      '    titular = { lockPath: `${ficheiro}.lock`, token: "sem-lock", timer: null, renovando: null, perdido: false };',
    ],
    ["    if (!(await titularAindaTemLock(titular))) {", "    if (false) {"],
    [
      "    const prev = await lerEstadoParaEscrita(ficheiro);",
      "    const prev = await lerEstadoParaEscrita(ficheiro);\n    await new Promise((r) => setTimeout(r, 3));",
    ],
  ]);
  try {
    fs.rmSync(DIR_INDEX, { recursive: true, force: true });
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
    await ind.startCatalogIndexingWorker(shop, {}, { causa: "painel" });
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
    const p1 = indexacao.startCatalogIndexingWorker("loja-tick.myshopify.com", {}, { causa: "painel" });
    const p2 = indexacao.startCatalogIndexingWorker("loja-tick.myshopify.com", {}, { causa: "painel" });
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
    const p1 = mutado.startCatalogIndexingWorker("loja-tick-mut.myshopify.com", {}, { causa: "painel" });
    const p2 = mutado.startCatalogIndexingWorker("loja-tick-mut.myshopify.com", {}, { causa: "painel" });
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
    const r1 = await indexacao.startCatalogIndexingWorker(shop, {}, { causa: "painel" });
    assert.equal(r1, null, "sem estado no disco, o arranque não se faz");
    assert.equal(forks, 0, "sem estado no disco, não pode haver fork");
    desbloquearEscrita();
    const r2 = await indexacao.startCatalogIndexingWorker(shop, {}, { causa: "painel" });
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
    await mutado.startCatalogIndexingWorker(shop, {}, { causa: "painel" });
    desbloquearEscrita();
    const r2 = await mutado.startCatalogIndexingWorker(shop, {}, { causa: "painel" });
    assert.equal(r2, null, "o mutante tem de devolver o resultado antigo, como o código antigo");
    assert.throws(() => assert.notEqual(r2, null));
  } finally {
    desbloquearEscrita();
    m.apagar();
  }
});

// ---------- (g) DBG-154: timer atrasado contra o flush do fim ----------
console.log("(g) DBG-154: timer atrasado não grava running sobre um estado terminal");
const lockModulo = await modulo("lib/curation/curationQueueFileLock.server.js");
const ESPERA_TIMER_MS = 5300; // debounce de 5 s, e uma folga

/** Como mutante(), mas com vários trechos trocados de uma vez. */
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

/**
 * O timer dispara com a memória em running e fica à espera do lock. Enquanto espera, a memória passa a completed
 * (é o que o flush do fim faz). Quando o lock sai, o disco tem de ficar completed. Com o snapshot tirado antes do
 * lock, o disco ficava running.
 */
async function cenarioSnapshotDentroDoLock(m, shop) {
  m.setInMemoryStatus(shop, { state: "running", indexing: true });
  const titular = await lockModulo.adquirirLockDoFicheiro(`${ficheiroDoEstado(shop)}.lock`, { prazoMs: 60_000 });
  m.writeCatalogRebuildStatus(shop, {});
  await new Promise((r) => setTimeout(r, ESPERA_TIMER_MS));
  m.setInMemoryStatus(shop, { state: "completed", indexing: false, finishedAt: new Date().toISOString() });
  await lockModulo.libertarLockDoFicheiro(titular);
  await new Promise((r) => setTimeout(r, 400));
  return JSON.parse(fs.readFileSync(ficheiroDoEstado(shop), "utf8")).state;
}

/** O disco já está completed (flush do fim). A memória tem um running antigo. O timer não pode regredir o disco. */
async function cenarioDefesaTerminal(m, shop) {
  await m.flushCatalogRebuildStatus(shop, { state: "completed", indexing: false, finishedAt: "2026-10-17T18:00:00.000Z" });
  m.setInMemoryStatus(shop, { state: "running", indexing: true });
  m.writeCatalogRebuildStatus(shop, {});
  await new Promise((r) => setTimeout(r, ESPERA_TIMER_MS + 400));
  return JSON.parse(fs.readFileSync(ficheiroDoEstado(shop), "utf8")).state;
}

const PAR_SNAPSHOT = [
  '    escreverEstadoComLock(shop, () => _memoryCache.get(shop) || {}, { origem: "timer" });',
  '    escreverEstadoComLock(shop, _memoryCache.get(shop) || {}, { origem: "timer" });',
];
const PAR_DEFESA = [
  '    if (origem === "timer" && ESTADOS_TERMINAIS.has(prev.state) && dados.state === "running") {',
  "    if (false) {",
];

await caso("timer com a memória lida dentro do lock: o disco fica completed", async () => {
  assert.equal(await cenarioSnapshotDentroDoLock(estado, "loja-timer-a.myshopify.com"), "completed");
});
await caso("timer atrasado não grava running sobre completed (defesa terminal)", async () => {
  assert.equal(await cenarioDefesaTerminal(estado, "loja-timer-b.myshopify.com"), "completed");
});
await caso("mutação: snapshot antes do lock faz o primeiro caso ficar vermelho", async () => {
  const m = mutanteVarios("lib/importer/catalog/catalogRebuildStatus.server.js", "snapshot-antigo", [PAR_SNAPSHOT]);
  try {
    const mutado = await modulo(path.relative(RAIZ, m.caminho));
    const final = await cenarioSnapshotDentroDoLock(mutado, "loja-timer-a.mut.myshopify.com");
    assert.equal(final, "running", "o mutante tem de gravar running, como o código antigo");
    assert.throws(() => assert.equal(final, "completed"));
  } finally {
    m.apagar();
  }
});
await caso("mutação: sem a defesa terminal faz o segundo caso ficar vermelho", async () => {
  const m = mutanteVarios("lib/importer/catalog/catalogRebuildStatus.server.js", "sem-defesa", [PAR_DEFESA]);
  try {
    const mutado = await modulo(path.relative(RAIZ, m.caminho));
    const final = await cenarioDefesaTerminal(mutado, "loja-timer-b.mut.myshopify.com");
    assert.equal(final, "running", "o mutante tem de regredir o disco, como o código antigo");
    assert.throws(() => assert.equal(final, "completed"));
  } finally {
    m.apagar();
  }
});
await caso("mutação combinada: snapshot antigo e sem defesa fazem os dois casos ficarem vermelhos", async () => {
  const m = mutanteVarios("lib/importer/catalog/catalogRebuildStatus.server.js", "combinada", [PAR_SNAPSHOT, PAR_DEFESA]);
  try {
    const mutado = await modulo(path.relative(RAIZ, m.caminho));
    const a = await cenarioSnapshotDentroDoLock(mutado, "loja-timer-a.comb.myshopify.com");
    const b = await cenarioDefesaTerminal(mutado, "loja-timer-b.comb.myshopify.com");
    assert.equal(a, "running");
    assert.equal(b, "running");
    assert.throws(() => assert.equal(a, "completed"));
    assert.throws(() => assert.equal(b, "completed"));
  } finally {
    m.apagar();
  }
});

// ---------- (h) lock partilhado: rótulo da espera esgotada ----------
console.log("(h) lock partilhado: rótulo da espera esgotada");
await caso("espera esgotada no estado da indexação usa o seu rótulo; a curadoria mantém o texto antigo", async () => {
  const lockPath = path.join(raiz, "rotulo", "x.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const titular = await lockModulo.adquirirLockDoFicheiro(lockPath, { prazoMs: 60_000 });
  try {
    await assert.rejects(
      lockModulo.adquirirLockDoFicheiro(lockPath, { prazoMs: 30, rotulo: "[estado] espera esgotada: estado da indexação ocupado" }),
      /estado da indexação ocupado/
    );
    await assert.rejects(lockModulo.adquirirLockDoFicheiro(lockPath, { prazoMs: 30 }), /fila de curadoria ocupada/);
  } finally {
    await lockModulo.libertarLockDoFicheiro(titular);
  }
});

if (falhas) {
  console.error(`\ndbg154-157-estado: ${falhas} verificação(ões) falharam`);
  process.exit(1);
}
console.log("\ndbg154-157-estado: todos os casos passaram");
