#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-156 (PR 1). Quatro partes, sem Fly nem BD reais (flyctl falso, diretórios temporários):
 *   (a) indexingStream.server.js: o running vai para o disco antes do fork. Pin de ordem no código.
 *       Mutação: retirar o flush tem de ficar vermelho.
 *   (b) maintenance.sh, portão: uma leitura livre não basta. A sonda repete-se durante GATE_REPEAT_SECONDS.
 *       Leitura livre seguida de indexação: código 75 e o catalog:health não corre. Tudo livre: corre.
 *       Mutação: sonda única tem de ficar vermelha.
 *   (c) maintenance.sh esperar_indexacao, o passo antes do deploy: com indexação ativa falha, e o comando
 *       seguinte (o deploy) não corre. Mutação: passo sem espera tem de ficar vermelho.
 *   (d) check-no-indexing.mjs: o cabeçalho não cita db_push_only. Mutação: pôr a citação de volta.
 * Uso: node scripts/tests/dbg156-indexacao.test.js
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SH = path.join(ROOT, "scripts", "ci", "maintenance.sh");
const CHECK = path.join(ROOT, "scripts", "maintenance", "check-no-indexing.mjs");
const INDEXING = path.join(ROOT, "lib", "importer", "catalog", "indexingStream.server.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbg156-"));

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

/**
 * flyctl falso. As sondas (comando com "base64 -d") contam-se em FAKE_CONT: as primeiras `livres` saem livres,
 * as seguintes devolvem a mensagem de indexação com código 1. Os comandos remotos vão para FAKE_LOG.
 */
function flyctlFalso(dir, livres) {
  const bin = path.join(dir, "flyctl");
  fs.writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'case "$6" in',
      '  *"base64 -d"*)',
      '    n=$(cat "$FAKE_CONT" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$FAKE_CONT"',
      `    if [ "$n" -le ${livres} ]; then exit 0; fi`,
      '    echo "[check-no-indexing] INDEXAÇÃO A DECORRER"; exit 1 ;;',
      '  *) echo "$6" >> "$FAKE_LOG"; exit 0 ;;',
      "esac",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  return bin;
}

/**
 * Corre o maintenance.sh com flyctl falso. Com `cadeia`, o comando seguinte (o deploy, simulado por um echo)
 * só corre se o passo sair com 0, como um `run` do GitHub Actions.
 */
function correrSh({ task, livres, repetir = 0, passo = 0, tentativas = 1, script = SH, cadeia = false, fase = "dry-run" }) {
  const dir = fs.mkdtempSync(path.join(tmp, "run-"));
  const log = path.join(dir, "log");
  const cont = path.join(dir, "cont");
  const env = {
    PATH: process.env.PATH,
    TMPDIR: tmp,
    FLYCTL: flyctlFalso(dir, livres),
    FAKE_LOG: log,
    FAKE_CONT: cont,
    GITHUB_STEP_SUMMARY: path.join(dir, "summary.md"),
    WAIT_STEP_SECONDS: "0",
    WAIT_MAX_ATTEMPTS: String(tentativas),
    GATE_REPEAT_SECONDS: String(repetir),
    GATE_REPEAT_STEP: String(passo),
  };
  const r = cadeia
    ? spawnSync("bash", ["-c", `bash "${script}" ${task} ${fase} && echo DEPLOY_CHAMADO`], { cwd: ROOT, encoding: "utf8", env })
    : spawnSync("bash", [script, task, fase], { cwd: ROOT, encoding: "utf8", env });
  return {
    ...r,
    calls: fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [],
    probes: fs.existsSync(cont) ? Number(fs.readFileSync(cont, "utf8").trim()) : 0,
  };
}

/** Cópia do maintenance.sh com um trecho trocado, num diretório à parte (ROOT próprio, com o check copiado). */
function mutante(nome, antigo, novo) {
  const sh = fs.readFileSync(SH, "utf8");
  assert.equal(sh.split(antigo).length - 1, 1, `mutação ${nome}: o trecho tem de existir uma vez`);
  const dir = fs.mkdtempSync(path.join(tmp, `mut-${nome}-`));
  fs.mkdirSync(path.join(dir, "scripts", "ci"), { recursive: true });
  fs.mkdirSync(path.join(dir, "scripts", "maintenance"), { recursive: true });
  fs.copyFileSync(CHECK, path.join(dir, "scripts", "maintenance", "check-no-indexing.mjs"));
  const script = path.join(dir, "scripts", "ci", "maintenance.sh");
  fs.writeFileSync(script, sh.replace(antigo, () => novo));
  return script;
}

console.log("(a) indexingStream: o running vai para o disco antes do fork");
// DBG-157/154: o flush é agora testado pelo resultado. A forma do código mudou, e o pin acompanha-a.
const FLUSH = "if (!(await flushCatalogRebuildStatus(shop, {}))) {";
/** O flush do running vem depois de setInMemoryStatus e antes do fork, dentro de startCatalogIndexingWorker. */
function verificarFlushAntesDoFork(src) {
  const inicio = src.indexOf("async function arrancarWorker(");
  assert.ok(inicio >= 0, "arrancarWorker em falta");
  const bloco = src.slice(inicio, src.indexOf("child = forkDoWorker(", inicio));
  const flush = bloco.indexOf(FLUSH);
  assert.ok(flush >= 0, "o running tem de ir para o disco antes do fork (DBG-156)");
  // A escrita em memória do arranque tem de estar antes do flush. Há outra depois, na falha do flush.
  assert.ok(bloco.slice(0, flush).includes("setInMemoryStatus(shop, {"), "setInMemoryStatus em falta antes do flush: a memória não tem o running");
}
const srcIndexing = fs.readFileSync(INDEXING, "utf8");
check("o flush do running está antes do fork, depois da memória", () => verificarFlushAntesDoFork(srcIndexing));
check("mutação: retirar o flush antes do fork faz a verificação falhar", () => {
  assert.ok(srcIndexing.includes(`${FLUSH}\n`), "o flush não existe no código");
  assert.throws(() => verificarFlushAntesDoFork(srcIndexing.replace(FLUSH, "if (!(true)) {")));
});
check("mutação: retirar a escrita do running em memória faz a verificação falhar", () => {
  assert.ok(srcIndexing.includes("  setInMemoryStatus(shop, {"), "a escrita em memória não existe no código");
  const semMemoria = srcIndexing.replace("  setInMemoryStatus(shop, {", "  outraFuncao(shop, {");
  assert.throws(() => verificarFlushAntesDoFork(semMemoria), /setInMemoryStatus em falta/);
});

console.log("(b) portão: a sonda repete-se antes de dar o catálogo por livre");
/** Portão do catalog_health: com indexação a meio, código 75 e o catalog:health não corre. */
function gateVerificado(r) {
  assert.equal(r.status, 75, `código: ${r.status} ${r.stderr}`);
  assert.deepEqual(r.calls, [], "com indexação a meio, o catalog:health não pode correr");
}
check("leitura livre seguida de indexação: código 75 e nenhum catalog:health", () => {
  const r = correrSh({ task: "catalog_health", livres: 1, repetir: 3, tentativas: 1 });
  gateVerificado(r);
  assert.ok(r.probes >= 2, "a sonda tem de se repetir depois da leitura livre");
});
check("sem janela (GATE_REPEAT_SECONDS=0): uma leitura livre custa uma sonda só", () => {
  const r = correrSh({ task: "catalog_health", livres: 1e9, repetir: 0, tentativas: 1 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.probes, 1, "a leitura livre não pode ser repetida por dentro do gate");
  assert.ok(r.calls.some((c) => c.includes("npm run catalog:health")));
});
check("tudo livre durante a janela: o catalog:health corre e a sonda repetiu-se", () => {
  const r = correrSh({ task: "catalog_health", livres: 1e9, repetir: 1, passo: 0, tentativas: 1 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.calls.some((c) => c.includes("npm run catalog:health")), "com tudo livre, o catalog:health tem de correr");
  assert.ok(r.probes >= 2, "a janela repete a sonda");
});
check("mutação: sonda única (sem repetir) faz o gate falhar", () => {
  const script = mutante("sonda-unica", "      confirmar_livre\n      rc=$?", "      rc=0");
  const r = correrSh({ task: "catalog_health", livres: 1, repetir: 3, tentativas: 1, script });
  assert.equal(r.status, 0, "o mutante tem de passar a leitura livre, como o código antigo");
  assert.ok(r.calls.some((c) => c.includes("npm run catalog:health")), "o mutante tem de correr o catalog:health");
  assert.throws(() => gateVerificado(r));
});

console.log("(c) esperar_indexacao: indexação ativa impede o deploy");
/** Com indexação ativa o passo tem de falhar, e o deploy (o comando seguinte) não pode correr. */
function deployBloqueado(r) {
  assert.notEqual(r.status, 0, "com indexação ativa, o passo tem de falhar");
  assert.ok(!r.stdout.includes("DEPLOY_CHAMADO"), "o deploy não pode correr com indexação ativa");
}
check("indexação ativa: o passo falha e o deploy não corre", () => {
  deployBloqueado(correrSh({ task: "esperar_indexacao", livres: 0, tentativas: 2, cadeia: true }));
});
check("esperar_indexacao recusa execute (sai com 64) e não chama a Fly", () => {
  const r = correrSh({ task: "esperar_indexacao", livres: 1e9, fase: "execute" });
  assert.equal(r.status, 64, `código: ${r.status} ${r.stderr}`);
  assert.deepEqual(r.calls, [], "com execute, a Fly não pode ser chamada");
});
check("mutação: deixar esperar_indexacao sair da guarda de execute faz a verificação falhar", () => {
  const script = mutante("sem-recusa", "  indexing_status | machine_status | esperar_indexacao)", "  indexing_status | machine_status)");
  const r = correrSh({ task: "esperar_indexacao", livres: 1e9, fase: "execute", script });
  assert.equal(r.status, 0, "o mutante tem de aceitar execute, como o código antigo");
  assert.throws(() => assert.equal(r.status, 64, "a recusa tem de sair com 64"));
});
check("sem indexação: o passo passa e o deploy corre", () => {
  const r = correrSh({ task: "esperar_indexacao", livres: 1e9, cadeia: true });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes("DEPLOY_CHAMADO"), "sem indexação, o comando seguinte tem de correr");
});
check("mutação: passo sem espera (código 0 com indexação ativa) deixa o deploy correr", () => {
  const script = mutante("sem-espera", 'RESULT_OVERRIDE="⏳ Indexação a decorrer, deploy não chamado"; RC=75 ;;', "RC=0 ;;");
  const r = correrSh({ task: "esperar_indexacao", livres: 0, tentativas: 2, cadeia: true, script });
  assert.equal(r.status, 0, "o mutante tem de sair com 0, como o código antigo");
  assert.ok(r.stdout.includes("DEPLOY_CHAMADO"), "o mutante tem de deixar o deploy correr");
  assert.throws(() => deployBloqueado(r));
});

console.log("(d) check-no-indexing.mjs: o cabeçalho não cita um input que não existe");
/** As primeiras 12 linhas não podem citar db_push_only: o deploy.yml não tem esse input. */
function cabecalhoLimpo(src) {
  assert.doesNotMatch(src.split("\n").slice(0, 12).join("\n"), /db_push_only/, "o cabeçalho cita db_push_only");
}
const srcCheck = fs.readFileSync(CHECK, "utf8");
check("o cabeçalho de check-no-indexing.mjs não cita db_push_only", () => cabecalhoLimpo(srcCheck));
check("mutação: citar db_push_only de novo no cabeçalho faz a verificação falhar", () => {
  assert.throws(() => cabecalhoLimpo(srcCheck.replace("Corre na Fly", "Corre na Fly (db_push_only)")));
});

console.log("(e) deploy.sh: a espera vem antes do flyctl deploy; o deploy.yml não tem uma segunda");
const DEPLOY_SCRIPT = path.join(ROOT, "scripts", "deploy.sh");
const DEPLOY_YML = path.join(ROOT, ".github", "workflows", "deploy.yml");
const BLOCO_ESPERA = 'if ! bash scripts/ci/maintenance.sh esperar_indexacao dry-run; then\n  fail "espera: indexação a decorrer ao fim de 15 min, ou estado ilegível. Repetir quando acabar (docs/runbook-deploy.md)."\nfi\n';
/** A espera corre esperar_indexacao e vem antes do exec flyctl deploy. */
function verificarEsperaAntesDoFlyctl(sh) {
  const i = sh.indexOf("bash scripts/ci/maintenance.sh esperar_indexacao dry-run");
  assert.ok(i >= 0, "a espera em falta no deploy.sh");
  assert.ok(i < sh.indexOf("exec flyctl deploy"), "a espera tem de vir antes do flyctl deploy");
}
/** O workflow não pode ter uma segunda espera: a única é a do deploy.sh. */
function semSegundaEsperaNoWorkflow(yml) {
  assert.doesNotMatch(yml, /esperar_indexacao/, "o deploy.yml não pode ter uma segunda espera");
}
const srcDeployScript = fs.readFileSync(DEPLOY_SCRIPT, "utf8");
check("a espera está no deploy.sh, antes do flyctl deploy", () => verificarEsperaAntesDoFlyctl(srcDeployScript));
check("o deploy.yml não tem passo de espera", () => semSegundaEsperaNoWorkflow(fs.readFileSync(DEPLOY_YML, "utf8")));
check("mutação: tirar a espera do deploy.sh faz a verificação falhar", () => {
  assert.ok(srcDeployScript.includes(BLOCO_ESPERA), "o bloco da espera não tem a forma esperada");
  assert.throws(() => verificarEsperaAntesDoFlyctl(srcDeployScript.replace(BLOCO_ESPERA, "")));
});

fs.rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.error(`\ndbg156-indexacao: ${failures} verificação(ões) falharam`);
  process.exit(1);
}
console.log("\ndbg156-indexacao: todos os casos passaram");
