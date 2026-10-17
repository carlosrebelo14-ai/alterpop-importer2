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
  const decisao = posicao(texto, "const recusaScript = motivoDeRecusaPorScript(scriptDeIndexacaoEmCurso());", ROTA_CICLO);
  const iife = posicao(texto, "void (async () => {", ROTA_CICLO);
  assert.ok(decisao < iife, "o ciclo tem de recusar com script antes de arrancar o IIFE");
  const bloco = texto.slice(decisao, iife);
  assert.match(
    bloco,
    /return Response\.json\(\s*\{ ok: true, skipped: true, reason: "script_indexing_running" \},\s*\{ status: 409/,
    "a recusa do ciclo tem de ser um return com reason e 409"
  );
}

/** O ciclo para quando a indexação não arranca, antes do IIFE seguir para a publicação. */
function verificarCicloPublicacao(texto) {
  const pos = posicao(texto, "if (publicacaoOuResetEmCurso()) {", ROTA_CICLO);
  const sync = posicao(texto, "if (await isShopifySyncRunning(shop)) {", ROTA_CICLO);
  assert.ok(pos < sync, "o POST tem de recusar com reset ou publicação antes do IIFE");
  assert.match(texto.slice(pos, sync), /reason: "publish_or_reset_running" \},\s*\{ status: 409/, "a recusa tem de ser 409 com causa");
  const marca = posicao(texto, 'reserva = tentarReservarPublicacao({ marcar: () => marcarAtividadeApp({ tipo: "publicacao" }) });', ROTA_CICLO);
  const decisao = posicao(texto, "motivoIndexacao = motivoDeRecusaDaPublicacaoManual({", ROTA_CICLO);
  assert.ok(marca < decisao, "a confirmação da indexação tem de vir depois da reserva com marca");
}

/** Purga: marca como script antes do arranque, e uma recusa do worker sai com código 1. */
const PURGA = "scripts/catalog/catalog-purge-reindex.js";
function verificarPurga(texto) {
  const recusa = posicao(texto, 'recusarSeAtividadeApp("catalog-purge-reindex");', PURGA);
  const marca = posicao(texto, 'marcarAtividadeApp({ tipo: "indexacao", origem: "script" })', PURGA);
  const arranque = posicao(texto, "iniciou = await startCatalogCleanupInBackground(shop, settings", PURGA);
  assert.ok(recusa < marca && marca < arranque, "a purga recusa, marca e só depois arranca o worker");
  assert.match(texto, /if \(iniciou === false\) \{[\s\S]*?process\.exit\(1\);/, "uma recusa do worker sai com código 1");
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
    assert.notEqual(mod.atividadeAppEmCurso()?.tipo, null, "a mutação tem de continuar a bloquear, e o caso (m) tem de apanhar isso");
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
    trocaUnica(t, "    if (dados.pid === process.pid) continue;\n", "")
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
  assert.throws(() => verificarPurga(trocaUnica(texto, "if (iniciou === false) {", "if (iniciou === undefined) {")));
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
  assert.throws(() => verificarCicloPublicacao(trocaUnica(ler(ROTA_CICLO_PUB), "motivoIndexacao = motivoDeRecusaDaPublicacaoManual({", "motivoIndexacao = null({")));
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

if (falhas) {
  console.error(`\ndbg140-141-guardas: ${falhas} verificação(ões) falharam`);
  process.exit(1);
}
console.log("\ndbg140-141-guardas: todos os casos passaram");
