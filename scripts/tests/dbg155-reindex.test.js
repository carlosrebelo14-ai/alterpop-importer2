#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-155 (PR 4). Sem Fly nem BD reais: PROJECT_ROOT e CURATION_DATA_DIR em diretórios temporários, fork falso.
 *   (a) full-catalog-reindex recusa com atividade da app viva: código 1, "Recusado", nada gravado no estado.
 *       Mutação: sem a recusa, o script segue e o caso acima tem de ficar vermelho.
 *   (b) full-catalog-reindex: a recusa e o marcador vêm antes do running, e o failed é gravado com await antes do
 *       exit, sem o texto do erro no log. Mutação: sem o await, a verificação fica vermelha.
 *   (c) startCatalogCleanupInBackground só resolve quando a corrida fecha, com o estado final no disco.
 *       Mutação: resolver no fork faz o caso ficar vermelho.
 *   (d) o marcador da corrida existe antes do fork e sai com o exit do worker. Mutação: marcar depois do fork
 *       faz o caso ficar vermelho.
 * Uso: node scripts/tests/dbg155-reindex.test.js
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
const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "dbg155-"));
process.on("exit", () => fs.rmSync(raiz, { recursive: true, force: true }));

// Antes de importar os módulos: o config lê PROJECT_ROOT ao carregar, e os scripts herdam o ambiente.
process.env.PROJECT_ROOT = raiz;

const modulo = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);
const indexacao = await modulo("lib/importer/catalog/indexingStream.server.js");
const atividade = await modulo("lib/curation/atividadeApp.js");
const dados = await modulo("lib/curation/dataDir.js");

const SHOP = "loja-reindex.myshopify.com";
const DIR_INDEX = path.join(raiz, "data", "catalog-index");
const ficheiroDoEstado = (shop) => path.join(DIR_INDEX, `${shop.replace(/\//g, "_")}-rebuild-status.json`);
const SCRIPT_REINDEX = "scripts/catalog/full-catalog-reindex.js";
const RECUSA = 'recusarSeAtividadeApp("full-catalog-reindex");';

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
    this.pid = 4343;
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

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

/** Marcadores de indexação na pasta de dados da curadoria. Limpa-os: um teste não herda sobras de outro. */
function marcadoresDeIndexacao() {
  const dir = dados.resolveCurationDataDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.startsWith("catalog-busy-indexacao-"));
}
function limparMarcadores() {
  for (const nome of marcadoresDeIndexacao()) fs.rmSync(path.join(dados.resolveCurationDataDir(), nome), { force: true });
}

/** Troca única: o trecho tem de existir exatamente uma vez, senão a mutação não diz o que pensa. */
function trocaUnica(texto, antigo, novo) {
  const vezes = texto.split(antigo).length - 1;
  if (vezes !== 1) throw new Error(`o trecho tem de existir uma vez (existe ${vezes}x): ${antigo.slice(0, 70)}`);
  return texto.replace(antigo, novo);
}

/** Cópia de um ficheiro com uma troca, na mesma pasta (os imports relativos continuam válidos). Quem chama apaga. */
function mutanteDo(relativo, nome, transformar) {
  const origem = path.join(RAIZ, relativo);
  const novo = transformar(fs.readFileSync(origem, "utf8"));
  const destino = path.join(path.dirname(origem), `.mutante-${nome}-${process.pid}.mjs`);
  fs.writeFileSync(destino, novo);
  return destino;
}

/** Corre o script com a atividade da app viva. Devolve o resultado e o que o script escreveu. */
function correrReindex(script = SCRIPT_REINDEX) {
  const marca = atividade.marcarAtividadeApp({ tipo: "publicacao", pid: process.pid });
  try {
    return spawnSync(process.execPath, [path.join(RAIZ, script)], {
      encoding: "utf8",
      env: { ...process.env, SHOP },
      timeout: 20000,
    });
  } finally {
    marca();
  }
}

function verificarRecusa(r) {
  assert.equal(r.status, 1, `código ${r.status} (sinal ${r.signal}); saída: ${(r.stdout + r.stderr).slice(-300)}`);
  assert.match(r.stdout + r.stderr, /\[full-catalog-reindex\] Recusado/);
}

/** A recusa vem antes do marcador, e o marcador antes do estado running. */
function verificarOrdemDaCorrida(src) {
  const recusa = src.indexOf(RECUSA);
  const marca = src.indexOf('marcarAtividadeApp({ tipo: "indexacao" })');
  const running = src.indexOf('state: "running"');
  assert.ok(recusa >= 0 && marca >= 0 && running >= 0, "âncoras da corrida em falta");
  assert.ok(recusa < marca && marca < running, "a recusa, o marcador e o running têm de estar nesta ordem");
}

/** No catch, o failed é gravado com await antes do exit, e o log não leva a variável do erro. */
function verificarFalhaEscrita(src) {
  const inicio = src.indexOf("} catch (err) {");
  assert.ok(inicio >= 0, "o catch do reindex tem de existir");
  const bloco = src.slice(inicio);
  const escrita = bloco.indexOf("await flushCatalogRebuildStatus(");
  const saida = bloco.indexOf("process.exit(1)");
  assert.ok(escrita >= 0 && saida >= 0, "âncoras do catch em falta");
  assert.ok(escrita < saida, "o failed tem de estar no disco antes do exit");
  const logs = [...bloco.matchAll(/console\.error\(([\s\S]*?)\);/g)].map((m) => m[1]);
  assert.ok(logs.length > 0, "o catch tem de dizer alguma coisa");
  assert.ok(logs.every((l) => !/\berr\b/.test(l)), "o log do catch não pode levar o erro");
}

/**
 * Arranque com fork falso. Devolve o número de marcadores que o fork viu (1 se o marcador existia antes do fork).
 * Depois acaba a corrida e confirma que o marcador só sai com o exit do worker.
 */
async function cenarioMarcador(mod) {
  limparMarcadores();
  let viu = null;
  let filho = null;
  mod.definirForkParaTestes(() => {
    viu = marcadoresDeIndexacao().length;
    filho = new FakeChild();
    return filho;
  });
  try {
    const promessa = mod.startCatalogCleanupInBackground(SHOP, {}, { causa: "script" });
    await esperarAte(() => filho !== null);
    filho.emit("message", { type: "done", indexed: 1, scanned: 1 });
    await promessa;
    assert.equal(marcadoresDeIndexacao().length, 1, "enquanto o worker vive, o marcador fica");
    filho.emit("exit", 0, null);
    assert.equal(marcadoresDeIndexacao().length, 0, "o exit do worker retira o marcador");
    return viu;
  } finally {
    mod.definirForkParaTestes(null);
  }
}

/** Arranque com fork falso. Devolve se a promessa resolveu antes de o worker fechar a corrida. */
async function cenarioPromessa(mod) {
  let filho = null;
  mod.definirForkParaTestes(() => {
    filho = new FakeChild();
    return filho;
  });
  try {
    let resolveuAntes = false;
    let resolveu = false;
    const promessa = mod.startCatalogCleanupInBackground(SHOP, {}, { causa: "script" }).then(() => {
      resolveu = true;
    });
    await esperarAte(() => filho !== null);
    await pausa(50);
    resolveuAntes = resolveu;
    filho.emit("message", { type: "done", indexed: 5, scanned: 5 });
    await promessa;
    return resolveuAntes;
  } finally {
    mod.definirForkParaTestes(null);
  }
}

console.log("dbg155 — reindexação completa e purga: recusa, falha gravada, espera pelo fim, marcador");

await caso("(a) full-catalog-reindex recusa com atividade da app viva: código 1, e nada é gravado no estado", () => {
  const r = correrReindex();
  verificarRecusa(r);
  assert.equal(fs.existsSync(ficheiroDoEstado(SHOP)), false, "o estado não pode ser escrito numa recusa");
});

await caso("mutação: sem a recusa, o script segue e o caso acima tem de ficar vermelho", () => {
  const m = mutanteDo(SCRIPT_REINDEX, "sem-recusa", (t) => trocaUnica(t, RECUSA, "void 0;"));
  try {
    const r = correrReindex(path.relative(RAIZ, m));
    assert.throws(() => verificarRecusa(r));
  } finally {
    fs.rmSync(m, { force: true });
  }
});

await caso("(b) full-catalog-reindex: recusa e marcador antes do running, failed com await antes do exit, log sem o erro", () => {
  const src = fs.readFileSync(path.join(RAIZ, SCRIPT_REINDEX), "utf8");
  verificarOrdemDaCorrida(src);
  verificarFalhaEscrita(src);
});

await caso("mutação: sem o await no failed, a verificação fica vermelha", () => {
  const m = mutanteDo(SCRIPT_REINDEX, "sem-await", (t) =>
    trocaUnica(t, "const gravouFalha = await flushCatalogRebuildStatus(", "const gravouFalha = flushCatalogRebuildStatus(")
  );
  try {
    assert.throws(() => verificarFalhaEscrita(fs.readFileSync(m, "utf8")));
  } finally {
    fs.rmSync(m, { force: true });
  }
});

await caso("(c) startCatalogCleanupInBackground só resolve no fim da corrida, com o estado completed no disco", async () => {
  const resolveuAntes = await cenarioPromessa(indexacao);
  assert.equal(resolveuAntes, false, "a promessa resolveu antes de o worker fechar a corrida");
  const disco = JSON.parse(fs.readFileSync(ficheiroDoEstado(SHOP), "utf8"));
  assert.equal(disco.state, "completed", "o estado final tem de estar no disco quando a promessa resolve");
});

await caso("mutação: resolver no fork faz o caso acima ficar vermelho", async () => {
  const m = mutanteDo("lib/importer/catalog/indexingStream.server.js", "resolve-no-fork", (t) =>
    trocaUnica(t, "if (!child) {", "parar();\n          resolve();\n        if (!child) {")
  );
  try {
    const mod = await import(pathToFileURL(m).href);
    const resolveuAntes = await cenarioPromessa(mod);
    assert.notEqual(resolveuAntes, false, "o caso (c) tem de apanhar a mutação");
  } finally {
    fs.rmSync(m, { force: true });
  }
});

await caso("(d) o marcador da corrida existe antes do fork e sai com o exit do worker", async () => {
  const viu = await cenarioMarcador(indexacao);
  assert.equal(viu, 1, "o marcador tem de existir quando o fork acontece");
});

await caso("mutação: marcar depois do fork faz o caso (d) ficar vermelho", async () => {
  const m = mutanteDo("lib/importer/catalog/indexingStream.server.js", "marcador-depois", (t) => {
    let novo = trocaUnica(t, 'retirarMarcador = marcarAtividadeApp({ tipo: "indexacao" });', "retirarMarcador = () => {};");
    novo = trocaUnica(novo, "  activeChildren.set(shop, child);\n", '  activeChildren.set(shop, child);\n  retirarMarcador = marcarAtividadeApp({ tipo: "indexacao" });\n');
    return novo;
  });
  try {
    const mod = await import(pathToFileURL(m).href);
    const viu = await cenarioMarcador(mod);
    assert.notEqual(viu, 1, "a mutação tem de deixar o fork sem marcador, e o caso (d) tem de apanhar isso");
  } finally {
    fs.rmSync(m, { force: true });
  }
});

if (falhas) {
  console.error(`\ndbg155-reindex: ${falhas} verificação(ões) falharam`);
  process.exit(1);
}
console.log("\ndbg155-reindex: todos os casos passaram");
