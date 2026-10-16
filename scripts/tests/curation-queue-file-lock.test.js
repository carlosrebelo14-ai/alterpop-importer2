#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-04, Decisão 35 (D1), decisão 1 do arquiteto. Lock de ficheiro entre processos da fila de
 * curadoria (lib/curation/curationQueueFileLock.server.js, usado por withCurationQueueLock).
 *
 * Casos:
 *   A  Dois processos reais alternam aprovações de SKU distintos. O pai aprova os seus e um filho
 *      (script que escreve a fila sem IPC) aprova os dele. No fim, nenhuma aprovação se perdeu.
 *   B  Lock com PID morto é libertado e a aprovação passa.
 *   C  Lock com PID vivo e hora de há mais de 10 min é libertado e a aprovação passa.
 *   D  Lock com PID vivo e fresco não é libertado. A escrita falha com CurationQueueLockError depois
 *      do prazo, e nada é gravado nem o lock é tocado (fail closed).
 *   E  O titular renova o lock enquanto trabalha. Um segundo processo não o toma como obsoleto.
 *   F  O lock é libertado mesmo quando a operação falha (aprovar um PUBLISHED).
 *   G  Dentro do lock, a cache em memória não é usada. Uma gravação de outro processo com o mesmo
 *      mtime é vista pela aprovação seguinte.
 *   H  Lock com PID vivo, escrito antes do arranque da máquina (PID reutilizado depois de reinício):
 *      é libertado.
 *   I  Limite de 10 min com os valores por omissão: lock de 5 min com PID vivo não é libertado; lock
 *      de 10 min e 30 s é.
 *   J  Lock tomado por outro token durante a posse: a renovação não o reescreve e marca o titular
 *      como perdido.
 *   K  O titular perde o lock a meio de uma operação: a operação lança CURATION_QUEUE_LOCK_LOST,
 *      regista "[fila] operação abortada: lock perdido" e não escreve a fila.
 *   L  Token confirmado antes de cada escrita: sem renovação no prazo, um token alheio no ficheiro
 *      aborta a escrita com CURATION_QUEUE_LOCK_LOST e nada é gravado.
 *
 * Os limites de tempo vêm de variáveis de ambiente só de teste (CURATION_QUEUE_LOCK_*).
 *
 * Uso: node scripts/tests/curation-queue-file-lock.test.js
 */
import "./_isolate-curation.js";

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const DATA_DIR = process.env.CURATION_DATA_DIR;
const DATABASE_URL = process.env.DATABASE_URL;
const QUEUE_PATH = path.join(DATA_DIR, "curation-queue.json");
const LOCK_PATH = path.join(DATA_DIR, "curation-queue.lock");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD_PATH = path.join(HERE, "_curation-queue-lock-child.mjs");
const QUEUE_MODULE = pathToFileURL(path.join(HERE, "..", "..", "lib", "curation", "curationQueue.server.js")).href;
const LOCK_MODULE = pathToFileURL(path.join(HERE, "..", "..", "lib", "curation", "curationQueueFileLock.server.js")).href;

const q = await import(QUEUE_MODULE);

const AGORA = new Date().toISOString();
const DEZ_MINUTOS_MS = 10 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Espera a promessa durante no máximo ms. Estouro de prazo é erro de harness, nunca passagem. */
function comPrazo(promessa, ms, descricao) {
  let timer;
  const prazo = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`prazo de ${ms} ms esgotado: ${descricao}`)), ms);
  });
  return Promise.race([promessa, prazo]).finally(() => clearTimeout(timer));
}

/** Promessa com resolve e reject expostos. Rejeição sem consumidor não é erro não tratado. */
function adiado() {
  let resolve;
  let reject;
  const promessa = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promessa.catch(() => {});
  return { promessa, resolve, reject };
}

/** Corre fn com o uptime da máquina fixado em segundos. Repõe o original no fim. */
async function comUptime(segundos, fn) {
  const real = os.uptime;
  os.uptime = () => segundos;
  try {
    return await fn();
  } finally {
    os.uptime = real;
  }
}

/** Corre fn com as variáveis de ambiente dadas e repõe o ambiente anterior no fim. */
async function comEnv(variaveis, fn) {
  const anteriores = {};
  for (const [nome, valor] of Object.entries(variaveis)) {
    anteriores[nome] = process.env[nome];
    process.env[nome] = String(valor);
  }
  try {
    return await fn();
  } finally {
    for (const nome of Object.keys(variaveis)) {
      if (anteriores[nome] === undefined) delete process.env[nome];
      else process.env[nome] = anteriores[nome];
    }
  }
}

function item(sku, status = "PENDING", metadata = {}) {
  return {
    sku,
    title_en: sku,
    status,
    reason: "teste_file_lock",
    shopifyStatus: status === "APPROVED" ? "ACTIVE" : "DRAFT",
    metadata: { vendor: "TESTVENDOR", category: "Toys", approvedAt: null, rejectedAt: null, queuedAt: AGORA, ...metadata },
  };
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

function escreverLock(conteudo) {
  fs.writeFileSync(LOCK_PATH, typeof conteudo === "string" ? conteudo : JSON.stringify(conteudo), "utf8");
}

function lockExiste() {
  return fs.existsSync(LOCK_PATH);
}

function limparLock() {
  fs.rmSync(LOCK_PATH, { force: true });
}

/** Processo vivo até ser morto. O seu PID é o de um titular vivo. */
function processoVivo() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
}

/** PID de um processo que já terminou. Não existe. */
async function pidMorto() {
  const processo = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => processo.on("exit", resolve));
  return processo.pid;
}

const filhos = new Set();
process.on("exit", () => {
  for (const filho of filhos) filho.kill("SIGKILL");
});

/**
 * Arranca um fork real de scripts/tests/_curation-queue-lock-child.mjs sobre a mesma fila.
 * Devolve ready (se waitGo), dentro (segurar: entrou no lock), fim (segurar: em de saída), done,
 * exited e go(). Qualquer erro do filho rejeita as promessas pendentes.
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

  const ready = adiado();
  const dentro = adiado();
  const fim = adiado();
  const done = adiado();
  const pendentes = [ready, dentro, fim, done];
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      filhos.delete(child);
      const erro = new Error(`filho saiu (code=${code}, signal=${signal}). Última saída: ${saida.trim()}`);
      for (const p of pendentes) p.reject(erro);
      resolve({ code, signal });
    });
  });
  child.on("message", (mensagem) => {
    if (mensagem?.type === "ready") ready.resolve();
    else if (mensagem?.type === "dentro") dentro.resolve();
    else if (mensagem?.type === "fim") fim.resolve(mensagem.em);
    else if (mensagem?.type === "done") done.resolve();
    else if (mensagem?.type === "error") {
      const erro = new Error(`filho falhou: ${mensagem.message}`);
      for (const p of pendentes) p.reject(erro);
    }
  });
  return {
    ready: ready.promessa,
    dentro: dentro.promessa,
    fim: fim.promessa,
    done: done.promessa,
    exited,
    go: () => child.send({ type: "go" }),
  };
}

const resultados = [];

async function caso(nome, fn) {
  try {
    await fn();
    resultados.push({ nome, resultado: "passa" });
    console.log(`  passa  ${nome}`);
  } catch (err) {
    resultados.push({ nome, resultado: "falha", detalhe: err.message });
    console.log(`  falha  ${nome}\n      ${String(err.message).split("\n").join("\n      ")}`);
  } finally {
    limparLock();
  }
}

// ---------------------------------------------------------------------------
// A: dois processos reais a alternar aprovações
// ---------------------------------------------------------------------------
async function casoAlternarEscritasEntreProcessos() {
  const N = 40;
  const enchimento = Array.from({ length: 600 }, (_, i) => item(`R${String(i).padStart(4, "0")}`));
  const doPai = Array.from({ length: N }, (_, i) => `P${String(i).padStart(3, "0")}`);
  const doFilho = Array.from({ length: N }, (_, i) => `F${String(i).padStart(3, "0")}`);
  escreverFila([...enchimento, ...doPai.map((s) => item(s)), ...doFilho.map((s) => item(s))]);

  const filho = startChild({ op: "aprovar", skus: doFilho }, { waitGo: true });
  await comPrazo(filho.ready, 20000, "arranque do filho");
  // Pai e filho começam ao mesmo tempo, cada um com N aprovações sobre SKU distintos.
  const pai = (async () => {
    for (const sku of doPai) await q.approveProduct(sku);
  })();
  filho.go();
  await comPrazo(Promise.all([pai, filho.done]), 120000, "aprovações alternadas do pai e do filho");
  await comPrazo(filho.exited, 20000, "saída do filho");

  const itens = lerFilaDoDisco();
  const aprovados = new Set(itens.filter((i) => i.status === "APPROVED").map((i) => i.sku));
  const esperados = [...doPai, ...doFilho];
  const perdidos = esperados.filter((sku) => !aprovados.has(sku));
  assert.deepEqual(perdidos, [], `aprovações perdidas: ${perdidos.length} de ${esperados.length}`);
  assert.equal(itens.length, enchimento.length + 2 * N, "entradas da fila");
  assert.equal(lockExiste(), false, "o lock tem de ser libertado no fim");
}

// ---------------------------------------------------------------------------
// B, C, D: lock deixado por outro processo
// ---------------------------------------------------------------------------
async function casoPidMortoLibertado() {
  escreverFila([item("X")]);
  escreverLock({ pid: await pidMorto(), em: new Date().toISOString(), token: "morto" });
  await comEnv({ CURATION_QUEUE_LOCK_PRAZO_MS: 2000 }, () => comPrazo(q.approveProduct("X"), 20000, "aprovação com lock de PID morto"));
  assert.equal(itemDoDisco("X").status, "APPROVED", "com PID morto a aprovação tem de passar");
  assert.equal(lockExiste(), false, "o lock de PID morto tem de ser libertado");
}

async function casoLockAntigoLibertado() {
  escreverFila([item("X")]);
  const vivo = processoVivo();
  filhos.add(vivo);
  try {
    const antigo = new Date(Date.now() - DEZ_MINUTOS_MS - 60_000).toISOString();
    escreverLock({ pid: vivo.pid, em: antigo, token: "antigo" });
    await comEnv({ CURATION_QUEUE_LOCK_PRAZO_MS: 2000 }, () => comPrazo(q.approveProduct("X"), 20000, "aprovação com lock antigo"));
    assert.equal(itemDoDisco("X").status, "APPROVED", "com hora de há mais de 10 min a aprovação tem de passar");
    assert.equal(lockExiste(), false, "o lock obsoleto tem de ser libertado");
  } finally {
    vivo.kill("SIGKILL");
    filhos.delete(vivo);
  }
}

// H: lock de PID vivo escrito antes do arranque da máquina é libertado (C1). Só o arranque o torna
// obsoleto: a hora tem 60 s, bem dentro dos 10 min.
async function casoLockAnteriorAoArranqueLibertado() {
  escreverFila([item("X")]);
  const vivo = processoVivo();
  filhos.add(vivo);
  try {
    const anterior = new Date(Date.now() - 60_000).toISOString();
    escreverLock({ pid: vivo.pid, em: anterior, token: "anterior-ao-arranque" });
    await comUptime(30, () =>
      comEnv({ CURATION_QUEUE_LOCK_PRAZO_MS: 2000 }, () => comPrazo(q.approveProduct("X"), 20000, "aprovação com lock anterior ao arranque"))
    );
    assert.equal(itemDoDisco("X").status, "APPROVED", "com lock escrito antes do arranque a aprovação tem de passar");
    assert.equal(lockExiste(), false, "o lock anterior ao arranque tem de ser libertado");
  } finally {
    vivo.kill("SIGKILL");
    filhos.delete(vivo);
  }
}

// J: a renovação não reescreve o lock de outro token (C3). Outro processo toma o lock durante a posse.
// A renovação vê o token diferente, não escreve, marca o titular como perdido e para de renovar.
async function casoRenovacaoNaoSobrescreveLockAlheio() {
  const lockMod = await import(LOCK_MODULE);
  const titular = await comEnv({ CURATION_QUEUE_LOCK_RENOVA_MS: 50 }, () =>
    comPrazo(lockMod.adquirirLockDoFicheiro(LOCK_PATH), 20000, "aquisição do lock na renovação")
  );
  const alheio = { pid: process.pid, em: new Date().toISOString(), token: "lock-de-outro-processo" };
  try {
    escreverLock(alheio);
    await sleep(400);
    assert.equal(titular.perdido, true, "com o lock tomado por outro token, a renovação tem de marcar o titular como perdido");
    assert.deepEqual(JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")), alheio, "a renovação não pode reescrever o lock de outro token");
  } finally {
    await lockMod.libertarLockDoFicheiro(titular);
  }
  assert.equal(lockExiste(), true, "libertar um titular perdido não pode remover o lock de outro token");
}

// I: limite de 10 min com os valores por omissão (sem CURATION_QUEUE_LOCK_OBSOLETO_MS). Só o prazo de
// espera é curto. Com arranque anterior, só a hora do lock decide. Um lock de 5 min (PID vivo) não é
// libertado. Um lock de 10 min e 30 s é libertado (apanha um limite de 11 min).
async function casoLimiteDeDezMinutos() {
  escreverFila([item("X")]);
  const vivo = processoVivo();
  filhos.add(vivo);
  try {
    const cincoMin = { pid: vivo.pid, em: new Date(Date.now() - 5 * 60_000).toISOString(), token: "cinco-minutos" };
    escreverLock(cincoMin);
    let erro = null;
    await comUptime(3600, () =>
      comEnv({ CURATION_QUEUE_LOCK_PRAZO_MS: 300 }, () => comPrazo(q.approveProduct("X"), 20000, "aprovação com lock de 5 min"))
    ).catch((e) => {
      erro = e;
    });
    assert.ok(erro, "com lock de 5 min (PID vivo, arranque anterior) a escrita tem de falhar, não libertar o lock");
    assert.equal(erro.code, "CURATION_QUEUE_LOCK_TIMEOUT", `erro inesperado: ${erro.message}`);
    assert.equal(itemDoDisco("X").status, "PENDING", "sem lock nada pode ser gravado");
    assert.deepEqual(JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")), cincoMin, "o lock de 5 min não pode ser tocado");

    escreverLock({ pid: vivo.pid, em: new Date(Date.now() - (DEZ_MINUTOS_MS + 30_000)).toISOString(), token: "dez-minutos-e-meio" });
    await comUptime(3600, () =>
      comEnv({ CURATION_QUEUE_LOCK_PRAZO_MS: 2000 }, () => comPrazo(q.approveProduct("X"), 20000, "aprovação com lock de 10 min e 30 s"))
    );
    assert.equal(itemDoDisco("X").status, "APPROVED", "com lock de mais de 10 min a aprovação tem de passar");
    assert.equal(lockExiste(), false, "o lock de mais de 10 min tem de ser libertado");
  } finally {
    vivo.kill("SIGKILL");
    filhos.delete(vivo);
  }
}

async function casoLockVivoEFrescoFalhaFechado() {
  escreverFila([item("X")]);
  const vivo = processoVivo();
  filhos.add(vivo);
  try {
    const conteudo = { pid: vivo.pid, em: new Date().toISOString(), token: "fresco" };
    escreverLock(conteudo);
    let erro = null;
    await comEnv({ CURATION_QUEUE_LOCK_PRAZO_MS: 300 }, () => comPrazo(q.approveProduct("X"), 20000, "aprovação com lock vivo e fresco")).catch((e) => {
      erro = e;
    });
    assert.ok(erro, "com lock de PID vivo e fresco a escrita tem de falhar");
    assert.equal(erro.code, "CURATION_QUEUE_LOCK_TIMEOUT", `erro inesperado: ${erro.message}`);
    assert.equal(itemDoDisco("X").status, "PENDING", "sem lock nada pode ser gravado");
    assert.deepEqual(JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")), conteudo, "o lock do titular vivo não pode ser tocado");
  } finally {
    vivo.kill("SIGKILL");
    filhos.delete(vivo);
  }
}

// ---------------------------------------------------------------------------
// E: renovação durante uma operação longa
// ---------------------------------------------------------------------------
async function casoRenovacaoImpedeRoubo() {
  escreverFila([item("X")]);
  await comEnv(
    { CURATION_QUEUE_LOCK_OBSOLETO_MS: 400, CURATION_QUEUE_LOCK_RENOVA_MS: 100, CURATION_QUEUE_LOCK_PRAZO_MS: 15000 },
    async () => {
      // O titular segura o lock 1,5 s. Sem renovação, o pai tomaria o lock aos 400 ms.
      const titular = startChild({ op: "segurar", holdMs: 1500 });
      await comPrazo(titular.dentro, 20000, "titular dentro do lock");
      const pedido = q.approveProduct("X").then(() => Date.now());
      const resolvidoEm = await comPrazo(pedido, 20000, "aprovação do pai");
      const fimDoTitular = await comPrazo(titular.fim, 20000, "fim do titular");
      await comPrazo(titular.exited, 20000, "saída do titular");
      assert.ok(
        resolvidoEm >= fimDoTitular,
        `o pai tomou o lock enquanto o titular ainda trabalhava (${fimDoTitular - resolvidoEm} ms antes do fim)`
      );
      assert.equal(itemDoDisco("X").status, "APPROVED", "a aprovação do pai tem de ficar gravada");
    }
  );
}

// ---------------------------------------------------------------------------
// F: libertação mesmo quando a operação falha
// ---------------------------------------------------------------------------
async function casoLibertaMesmoComFalha() {
  escreverFila([item("PUB", "PUBLISHED", { shopifyProductId: "gid://shopify/Product/9" }), item("X")]);
  let erro = null;
  await comPrazo(q.approveProduct("PUB"), 20000, "aprovação de PUBLISHED").catch((e) => {
    erro = e;
  });
  assert.ok(erro, "pré-condição: aprovar um PUBLISHED tem de falhar");
  assert.equal(lockExiste(), false, "o lock tem de ser libertado depois de a operação falhar");
  await comEnv({ CURATION_QUEUE_LOCK_PRAZO_MS: 500 }, () => comPrazo(q.approveProduct("X"), 20000, "aprovação depois de falha"));
  assert.equal(itemDoDisco("X").status, "APPROVED", "a operação seguinte tem de passar sem esperar pelo prazo");
}

// ---------------------------------------------------------------------------
// G: cache em memória não é usada dentro do lock
// ---------------------------------------------------------------------------
async function casoCacheNaoUsadaDentroDoLock() {
  escreverFila([item("X"), item("Y")]);
  const antes = await q.loadCurationQueue();
  assert.equal(antes.items.find((i) => i.sku === "X").status, "PENDING", "pré-condição: a cache tem X em PENDING");

  // Outro processo grava X como APPROVED. Simula-se o mtime igual ao da cache (granularidade do relógio).
  const statReal = fsp.stat;
  const mtimeDaCache = (await statReal(QUEUE_PATH)).mtimeMs;
  fsp.stat = async function statComMtimeDaCache(ficheiro, ...resto) {
    const resultado = await statReal.call(fsp, ficheiro, ...resto);
    if (String(ficheiro) === QUEUE_PATH) resultado.mtimeMs = mtimeDaCache;
    return resultado;
  };
  try {
    fs.writeFileSync(QUEUE_PATH, JSON.stringify({ version: 1, updatedAt: null, items: [item("X", "APPROVED"), item("Y")] }), "utf8");
    await comPrazo(q.approveProduct("Y"), 20000, "aprovação de Y com cache");
  } finally {
    fsp.stat = statReal;
  }
  assert.equal(itemDoDisco("X").status, "APPROVED", "a aprovação de X feita por outro processo foi apagada pela cache em memória");
  assert.equal(itemDoDisco("Y").status, "APPROVED", "a aprovação de Y tem de ficar gravada");
}

// ---------------------------------------------------------------------------
// K: titular que perde o lock a meio não escreve a fila
// ---------------------------------------------------------------------------
async function casoPerdaDoLockAbortaSemEscrever() {
  escreverFila([item("X"), item("Y")]);
  const antes = fs.readFileSync(QUEUE_PATH, "utf8");
  const registos = [];
  const erroOriginal = console.error;
  console.error = (...args) => registos.push(args.join(" "));
  let erro = null;
  try {
    await comEnv({ CURATION_QUEUE_LOCK_RENOVA_MS: 20 }, () =>
      comPrazo(
        q.mutateCurationQueue(async (fila) => {
          // Outro processo toma o lock: o token do titular sai do ficheiro. A renovação (20 ms)
          // vê o token alheio e marca o titular como perdido. Só depois a operação escreve.
          escreverLock({ pid: process.pid, em: new Date().toISOString(), token: "outro-titular" });
          await sleep(200);
          fila.items.find((i) => i.sku === "X").status = "APPROVED";
          return { gravar: true, valor: undefined };
        }),
        20000,
        "operação com lock perdido"
      ).catch((e) => {
        erro = e;
      })
    );
  } finally {
    console.error = erroOriginal;
  }
  assert.ok(erro, "a operação tem de falhar quando o titular perde o lock");
  assert.equal(erro.code, "CURATION_QUEUE_LOCK_LOST", `código do erro: ${erro.code}`);
  assert.equal(fs.readFileSync(QUEUE_PATH, "utf8"), antes, "a operação não pode gravar depois de perder o lock");
  assert.ok(
    registos.some((r) => r.includes("[fila] operação abortada: lock perdido")),
    `falta o registo do aborto. Registos: ${registos.join(" | ")}`
  );
  assert.deepEqual(
    fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".tmp")),
    [],
    "o aborto não pode deixar ficheiro temporário"
  );
}

// ---------------------------------------------------------------------------
// L: token confirmado no ficheiro antes de cada escrita
// ---------------------------------------------------------------------------
async function casoTokenConfirmadoAntesDeEscrever() {
  escreverFila([item("X")]);
  const antes = fs.readFileSync(QUEUE_PATH, "utf8");
  const erroOriginal = console.error;
  console.error = () => {};
  let erro = null;
  try {
    // Renovação a 60 s: no prazo do teste não corre nenhuma. Só a confirmação no ficheiro pode ver o token alheio.
    await comEnv({ CURATION_QUEUE_LOCK_RENOVA_MS: 60000 }, () =>
      comPrazo(
        q.mutateCurationQueue(async (fila) => {
          escreverLock({ pid: process.pid, em: new Date().toISOString(), token: "outro-titular" });
          fila.items.find((i) => i.sku === "X").status = "APPROVED";
          return { gravar: true, valor: undefined };
        }),
        20000,
        "escrita com token alheio"
      ).catch((e) => {
        erro = e;
      })
    );
  } finally {
    console.error = erroOriginal;
  }
  assert.ok(erro, "a escrita tem de falhar quando o token no ficheiro já não é o do titular");
  assert.equal(erro.code, "CURATION_QUEUE_LOCK_LOST", `código do erro: ${erro.code}`);
  assert.equal(fs.readFileSync(QUEUE_PATH, "utf8"), antes, "nada pode ser gravado com token alheio");
}

async function main() {
  await caso("A  dois processos a alternar aprovações, nenhuma perdida", casoAlternarEscritasEntreProcessos);
  await caso("B  lock com PID morto é libertado", casoPidMortoLibertado);
  await caso("C  lock com hora de há mais de 10 min é libertado", casoLockAntigoLibertado);
  await caso("D  lock com PID vivo e fresco não é libertado: falha fechada depois do prazo", casoLockVivoEFrescoFalhaFechado);
  await caso("E  o titular renova o lock e um segundo processo não o rouba", casoRenovacaoImpedeRoubo);
  await caso("F  o lock é libertado quando a operação falha", casoLibertaMesmoComFalha);
  await caso("G  dentro do lock não se usa a cache em memória", casoCacheNaoUsadaDentroDoLock);
  await caso("H  lock com PID vivo escrito antes do arranque da máquina é libertado", casoLockAnteriorAoArranqueLibertado);
  await caso("I  limite de 10 min por omissão: 5 min não é libertado, 10 min e 30 s é", casoLimiteDeDezMinutos);
  await caso("J  renovação não reescreve o lock de outro token e marca o titular como perdido", casoRenovacaoNaoSobrescreveLockAlheio);
  await caso("K  titular que perde o lock a meio aborta sem escrever", casoPerdaDoLockAbortaSemEscrever);
  await caso("L  token confirmado no ficheiro antes de cada escrita", casoTokenConfirmadoAntesDeEscrever);

  console.log("\nRESUMO");
  for (const r of resultados) console.log(`  ${r.resultado.padEnd(6)} ${r.nome}`);
  const nao = resultados.filter((r) => r.resultado !== "passa").length;
  if (nao) {
    console.error(`\n${nao} caso(s) não passam`);
    process.exit(1);
  }
  console.log("\ncuration-queue-file-lock: todos os casos passaram");
}

await main();
