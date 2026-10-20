#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-50 — tarefa active_vs_queue (só leitura): produtos ACTIVE da loja contra a fila de curadoria.
 *   (a) classificação pura por estado da fila, com contagens certas;
 *   (b) a saída nunca tem SKU, título, conteúdo da fila nem mensagem de erro da Shopify;
 *       lista de processos node só com nomes de scripts (sem código inline nem argumentos);
 *   (c) maintenance.sh: caso active_vs_queue sem escrita, e um run com flyctl falso;
 *   (d) maintenance.yml: a tarefa está nas opções e fora do job de escrita.
 * Isolamento: diretórios temporários (TMPDIR); a Shopify e a Fly são falsas. Não toca em BD nem na loja.
 * Uso: node scripts/tests/active-vs-queue.test.js
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classificarActiveVsQueue,
  executar,
  formatarResumo,
  listarProcessosNode,
  nomeDoScript,
} from "../maintenance/active-vs-queue.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT_SH = path.join(ROOT, "scripts/ci/maintenance.sh");
const YML = path.join(ROOT, ".github/workflows/maintenance.yml");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "avq-"));

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

// Fixtures sintéticas. Os SKUs e o título têm uma marca SEGREDO para o teste de fuga.
const FILA = [
  { sku: "SEGREDO-DBG50-APR", status: "APPROVED", title_en: "Título Secreto DBG50" },
  { sku: "SEGREDO-DBG50-PUB1", status: "PUBLISHED" },
  { sku: "SEGREDO-DBG50-PUB2", status: "PUBLISHED" },
  { sku: "SEGREDO-DBG50-PEN", status: "PENDING" },
  { sku: "SEGREDO-DBG50-REJ", status: "REJECTED" },
  { sku: "SEGREDO-DBG50-ERR", status: "SYNC_ERROR" },
  { sku: "SEGREDO-DBG50-DUP", status: "APPROVED" },
  { sku: "SEGREDO-DBG50-DUP", status: "REJECTED" }, // duplicado: vale a primeira entrada
  { sku: "SEGREDO-DBG50-SO-FILA", status: "PENDING" }, // na fila mas sem ACTIVE: não conta
];
const ATIVOS = [
  "SEGREDO-DBG50-APR",
  "SEGREDO-DBG50-PUB1",
  "SEGREDO-DBG50-PUB2",
  "SEGREDO-DBG50-PEN",
  "SEGREDO-DBG50-REJ",
  "SEGREDO-DBG50-ERR",
  "SEGREDO-DBG50-DUP",
  "SEGREDO-DBG50-SEM-ENTRADA",
  null,
];
const SKUS_PROIBIDOS = ["SEGREDO-DBG50", "Título Secreto"];

/** Pasta de fila temporária com a fila dada. Devolve o caminho do curation-queue.json. */
function escreverFila(nome, conteudo) {
  const dir = fs.mkdtempSync(path.join(tmp, `${nome}-`));
  const caminho = path.join(dir, "curation-queue.json");
  fs.writeFileSync(caminho, typeof conteudo === "string" ? conteudo : JSON.stringify({ version: 1, items: conteudo }));
  return caminho;
}

/** /proc falso: cada entrada é [pid, comm, argv]. */
function escreverProc(entradas) {
  const dir = fs.mkdtempSync(path.join(tmp, "proc-"));
  for (const [pid, comm, argv] of entradas) {
    fs.mkdirSync(path.join(dir, String(pid)));
    fs.writeFileSync(path.join(dir, String(pid), "comm"), `${comm}\n`);
    fs.writeFileSync(path.join(dir, String(pid), "cmdline"), argv.join("\0") + "\0");
  }
  return dir;
}

console.log("(a) classificação por estado da fila");
await check("cada estado conta na sua categoria, com contagens certas", () => {
  const c = classificarActiveVsQueue(ATIVOS, FILA);
  assert.deepEqual(c, { total: 9, APPROVED: 2, PUBLISHED: 2, PENDING: 1, REJECTED: 1, outro_estado: 1, sem_entrada: 1, sem_sku: 1 });
});
await check("as categorias somam o total (cada produto cai numa só)", () => {
  const c = classificarActiveVsQueue(ATIVOS, FILA);
  const soma = c.APPROVED + c.PUBLISHED + c.PENDING + c.REJECTED + c.outro_estado + c.sem_entrada + c.sem_sku;
  assert.equal(soma, c.total);
});
await check("PUBLISHED não entra em APPROVED, e APPROVED não entra em PUBLISHED", () => {
  const c = classificarActiveVsQueue(["A"], [{ sku: "A", status: "PUBLISHED" }]);
  assert.equal(c.PUBLISHED, 1);
  assert.equal(c.APPROVED, 0);
});
await check("fila sem entradas: todos os ACTIVE com SKU são sem entrada", () => {
  const c = classificarActiveVsQueue(["X1", "X2"], []);
  assert.equal(c.sem_entrada, 2);
  assert.equal(c.total, 2);
});

console.log("(b) saída sem SKU, título nem conteúdo da fila");
await check("executar: fila e loja falsas → só contagens; nenhum SKU, título ou linha da fila na saída", async () => {
  const caminho = escreverFila("b-ok", FILA);
  const antes = fs.readFileSync(caminho, "utf8");
  const r = await executar({
    caminhoFila: caminho,
    lerSkusActivos: async () => ATIVOS,
    procDir: escreverProc([[101, "node", ["/usr/bin/node", "scripts/sync/live-sync-daemon.js"]]]),
    ignorarPid: 4242,
  });
  assert.equal(r.codigo, "ok");
  const saida = r.linhas.join("\n");
  for (const proibido of SKUS_PROIBIDOS) assert.ok(!saida.includes(proibido), `saída com "${proibido}"`);
  assert.match(saida, /^AVQ: total=9$/m);
  assert.match(saida, /^AVQ: APPROVED=2$/m);
  assert.match(saida, /^AVQ: PUBLISHED=2$/m);
  assert.match(saida, /^AVQ: sem_entrada=1$/m);
  assert.match(saida, /^AVQ: proc=live-sync-daemon\.js$/m);
  assert.equal(fs.readFileSync(caminho, "utf8"), antes, "a fila não foi alterada");
});
await check("falha da Shopify: só o código, sem a mensagem (que pode trazer dados da loja)", async () => {
  const caminho = escreverFila("b-shop", FILA);
  const r = await executar({
    caminhoFila: caminho,
    lerSkusActivos: async () => {
      throw new Error(`Shopify HTTP 500: {"products":"${ATIVOS[0]}"}`);
    },
    procDir: "/nao/existe",
  });
  assert.equal(r.codigo, "shopify_falhou");
  assert.deepEqual(r.linhas, ["AVQ: erro=shopify_falhou"]);
});
await check("fila em falta ou ilegível: para sem contar e sem chamar a loja", async () => {
  let chamadas = 0;
  const lerSkusActivos = async () => {
    chamadas += 1;
    return ATIVOS;
  };
  let r = await executar({ caminhoFila: path.join(tmp, "nao-existe", "curation-queue.json"), lerSkusActivos, procDir: "/nao/existe" });
  assert.deepEqual(r, { codigo: "fila_em_falta", linhas: ["AVQ: erro=fila_em_falta"] });
  r = await executar({ caminhoFila: escreverFila("corrompida", "{ isto não é json"), lerSkusActivos, procDir: "/nao/existe" });
  assert.deepEqual(r, { codigo: "fila_ilegivel", linhas: ["AVQ: erro=fila_ilegivel"] });
  r = await executar({ caminhoFila: escreverFila("sem-items", '{"version":1}'), lerSkusActivos, procDir: "/nao/existe" });
  assert.deepEqual(r, { codigo: "fila_ilegivel", linhas: ["AVQ: erro=fila_ilegivel"] });
  assert.equal(chamadas, 0);
});
await check("processos: só o nome do script; código inline, argumentos e nomes estranhos não saem", () => {
  const proc = escreverProc([
    [101, "node", ["/usr/bin/node", "scripts/sync/live-sync-daemon.js"]],
    [102, "node", ["/usr/bin/node", "-e", "console.log('SEGREDO-DBG50-EVAL')"]],
    [103, "sh", ["sh", "-lc", "cd /app && node scripts/sync/live-sync-daemon.js"]],
    [104, "node", ["/usr/bin/node", "--input-type=module", "-"]],
    [105, "node", ["/usr/bin/node", "/app/pasta com espaços/x y.js"]],
    [106, "node", ["/usr/bin/node", "/app/ficheiro?token=SEGREDO-DBG50-TOKEN.js"]],
    [4242, "node", ["/usr/bin/node", "scripts/maintenance/active-vs-queue.mjs"]],
  ]);
  const nomes = listarProcessosNode(proc, 4242);
  assert.deepEqual([...nomes].sort(), ["(código inline)", "(outro)", "(outro)", "(stdin)", "live-sync-daemon.js"]);
  assert.ok(!formatarResumo({ total: 0 }, nomes).join("\n").includes("SEGREDO"));
});
await check("nomeDoScript: só o basename de um ficheiro .js/.mjs/.cjs simples", () => {
  assert.equal(nomeDoScript(["scripts/sync/live-sync-daemon.js"]), "live-sync-daemon.js");
  assert.equal(nomeDoScript(["--input-type=module", "-"]), "(stdin)");
  assert.equal(nomeDoScript(["-e", "x"]), "(código inline)");
  assert.equal(nomeDoScript(["--eval=SEGREDO"]), "(código inline)");
  assert.equal(nomeDoScript([]), "(sem script)");
  assert.equal(nomeDoScript(["a=b.js"]), "(outro)");
});
await check("sem /proc (ex.: macOS): processos = null e a linha fica como pedido", () => {
  assert.equal(listarProcessosNode("/nao/existe/proc", 4242), null);
  assert.ok(formatarResumo({ total: 0 }, null).includes("processos: não consegui listar"));
});

console.log("(c) maintenance.sh");
const sh = fs.readFileSync(SCRIPT_SH, "utf8");
const semComentarios = sh.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

/**
 * Bloco de execução do caso (o que chama a Fly). Procura o caso que contém `remote "node …"`, e não o do resumo.
 * Falha se não existir: sem isto, as asserções sobre o bloco passariam em vazio.
 */
function blocoExecucao() {
  for (const m of semComentarios.matchAll(/\n {2}active_vs_queue\)\n/g)) {
    const bloco = semComentarios.slice(m.index, semComentarios.indexOf("\n    ;;", m.index));
    if (/remote "node /.test(bloco)) return bloco;
  }
  assert.fail("bloco de execução active_vs_queue em falta");
}
await check("caso active_vs_queue na execução (e no resumo), e a chamada remota certa", () => {
  assert.equal([...semComentarios.matchAll(/\n {2}active_vs_queue\)\n/g)].length, 2);
  assert.match(blocoExecucao(), /remote "node scripts\/maintenance\/active-vs-queue\.mjs"/);
});
await check("o bloco active_vs_queue só lê: nenhum comando de escrita", () => {
  assert.doesNotMatch(blocoExecucao(), /--execute|db:push|migrate|snapshots create|volumes create|tags-cleanup|character-pages-sync|tagsRemove|productUpdate|metafieldsSet|sftp put|rm -/);
});
await check("active_vs_queue fica fora de WRITES e na lista que recusa execute", () => {
  const linhaWrites = sh.split("\n").find((l) => l.includes("WRITES=true ;;"));
  assert.ok(linhaWrites && !linhaWrites.includes("active_vs_queue"));
  assert.match(sh, /^ {2}db_flag_check \| logs_recent \| restore_dry_run \| active_vs_queue(?: \| elite_purge_dry_run)?\)$/m);
  assert.match(sh, /\| restore_dry_run \| active_vs_queue(?: \| elite_purge_dry_run)?(?: \| indexing_status)?(?: \| machine_status)?(?: \| esperar_indexacao)?(?: \| scale_memory)?\) ;;/);
});

/** flyctl falso: o comando remoto (argumento 6) vai para o log e a saída vem de FAKE_OUT. */
function correrSh(task, phase, { saida, rc = 0 }) {
  const dir = fs.mkdtempSync(path.join(tmp, "sh-"));
  const bin = path.join(dir, "flyctl");
  const log = path.join(dir, "log");
  const out = path.join(dir, "out.txt");
  const summary = path.join(dir, "summary.md");
  fs.writeFileSync(out, saida);
  fs.writeFileSync(bin, '#!/bin/sh\necho "$6" >> "$FAKE_LOG"\ncat "$FAKE_OUT"\nexit "$FAKE_RC"\n', { mode: 0o755 });
  const r = spawnSync("bash", [SCRIPT_SH, task, phase], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      TMPDIR: tmp,
      FLYCTL: bin,
      FAKE_LOG: log,
      FAKE_OUT: out,
      FAKE_RC: String(rc),
      GITHUB_STEP_SUMMARY: summary,
      WAIT_STEP_SECONDS: "0",
      GATE_REPEAT_SECONDS: "0",
      WAIT_MAX_ATTEMPTS: "1",
    },
  });
  return {
    ...r,
    calls: fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [],
    summaryText: fs.existsSync(summary) ? fs.readFileSync(summary, "utf8") : "",
  };
}

const SAIDA_OK = [
  "AVQ: total=57",
  "AVQ: APPROVED=3",
  "AVQ: PUBLISHED=40",
  "AVQ: PENDING=10",
  "AVQ: REJECTED=1",
  "AVQ: outro_estado=1",
  "AVQ: sem_entrada=2",
  "AVQ: sem_sku=0",
  "AVQ: processos_node=2",
  "AVQ: proc=live-sync-daemon.js",
  "AVQ: proc=(stdin)",
  "SEGREDO-DBG50-LINHA-EM-BRUTO",
].join("\n") + "\n";

await check("run com flyctl falso: resumo em contagens, sem linhas em bruto, só leitura", () => {
  const r = correrSh("active_vs_queue", "dry-run", { saida: SAIDA_OK });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.length, 1);
  assert.match(r.calls[0], /node scripts\/maintenance\/active-vs-queue\.mjs/);
  assert.match(r.summaryText, /Produtos ACTIVE na loja: \*\*57\*\*; sem SKU: \*\*0\*\*\./);
  assert.match(r.summaryText, /APPROVED \*\*3\*\*, PUBLISHED \*\*40\*\*, PENDING \*\*10\*\*, REJECTED \*\*1\*\*, outro estado \*\*1\*\*/);
  assert.match(r.summaryText, /Sem entrada na fila: \*\*2\*\*/);
  assert.match(r.summaryText, /ACTIVE fora de APPROVED e PUBLISHED: \*\*14\*\*/);
  assert.match(r.summaryText, /Processos node na máquina: \*\*2\*\* \(live-sync-daemon\.js, \(stdin\)\)/);
  assert.match(r.summaryText, /Em resumo:\*\* 57 ACTIVE: 3 APPROVED, 40 PUBLISHED/);
  assert.match(r.summaryText, /só leitura/);
  assert.match(r.summaryText, /Concluída sem erros/);
  assert.ok(!r.summaryText.includes("SEGREDO"), "o resumo não repete linhas em bruto");
  assert.ok(!r.stdout.includes("SEGREDO"), "a saída não repete linhas em bruto");
});
await check("execute não se aplica: recusa com 64 e não chama a Fly", () => {
  const r = correrSh("active_vs_queue", "execute", { saida: SAIDA_OK });
  assert.equal(r.status, 64);
  assert.equal(r.calls.length, 0);
});
await check("fila em falta ou Shopify em erro: falha com causa classificada, sem detalhe", () => {
  let r = correrSh("active_vs_queue", "dry-run", { saida: "AVQ: erro=fila_em_falta\n", rc: 1 });
  assert.equal(r.status, 1);
  assert.match(r.summaryText, /a fila de curadoria não existe no volume/);
  r = correrSh("active_vs_queue", "dry-run", { saida: "AVQ: erro=shopify_falhou\n", rc: 1 });
  assert.match(r.summaryText, /não consegui ler os produtos ACTIVE pela API da loja/);
});
await check("sem listagem de processos: diz que não conseguiu, e não inventa contagem", () => {
  const saida = SAIDA_OK.replace(/AVQ: processos_node=2\n(AVQ: proc=.*\n)+/, "processos: não consegui listar\n");
  const r = correrSh("active_vs_queue", "dry-run", { saida });
  assert.equal(r.status, 0);
  assert.match(r.summaryText, /Processos na máquina: não consegui listar\./);
});

console.log("(d) maintenance.yml");
const yml = fs.readFileSync(YML, "utf8");
const ymlCodigo = yml.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
await check("active_vs_queue nas opções da tarefa, logo a seguir a restore_dry_run", () => {
  assert.match(ymlCodigo, /\n\s+- restore_dry_run\n\s+- active_vs_queue\n\s+- elite_purge_dry_run\n\s+- indexing_status\n\s+- machine_status\n\s+- scale_memory\n\s+mode:/);
});
await check("o job de escrita (execute) não a inclui: a lista de tarefas que escrevem é a mesma", () => {
  const job = ymlCodigo.slice(ymlCodigo.indexOf("  execute:"));
  assert.doesNotMatch(job, /active_vs_queue/);
  assert.match(job, /contains\(fromJSON\('\["volume_snapshot","tags_cleanup","character_pages_sync","db_push","scale_memory"\]'\), inputs\.task\)/);
});
await check("o job dry-run corre só dry-run (sem environment e sem execute)", () => {
  const job = ymlCodigo.slice(ymlCodigo.indexOf("  dry-run:"), ymlCodigo.indexOf("  execute:"));
  assert.doesNotMatch(job, /environment:/);
  assert.match(job, /maintenance\.sh "\$TASK" dry-run/);
});
await check("cabeçalho do workflow diz que active_vs_queue só lê", () => {
  assert.match(yml, /^#\s+\(db_flag_check, logs_recent, restore_dry_run, active_vs_queue, elite_purge_dry_run, indexing_status e machine_status só leem: nunca entram no job de escrita\)$/m);
});

fs.rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.error(`\nactive-vs-queue: ${failures} falha(s)`);
  process.exit(1);
}
console.log("\nactive-vs-queue: todos os casos passaram");
