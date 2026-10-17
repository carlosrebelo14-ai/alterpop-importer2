#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-43 — tarefa elite_purge_dry_run (só leitura, só dry-run).
 *   (a) formatação: só contagens com prefixo EPD:, sem SKU nem texto livre;
 *   (b) executar: a purga entra como dependência; o dry-run nunca chama escrita (apagar, fila, log);
 *       fila em falta, ilegível ou catálogo em falha → código de erro sem detalhe;
 *   (c) maintenance.sh: execute é recusado para esta tarefa (código 64, sem chamar a Fly); o run com
 *       flyctl falso só resume em contagens, sem linhas em bruto; o bloco de execução não tem escrita;
 *   (d) maintenance.yml: a tarefa está nas opções e fora do job de escrita (environment production).
 * Isolamento: diretórios temporários; a Fly e a BD são falsas. Não toca na BD nem na fila real.
 * Uso: node scripts/tests/elite-purge-dry-run.test.js
 */
import "./_isolate-curation.js";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT_SH = path.join(ROOT, "scripts/ci/maintenance.sh");
const YML = path.join(ROOT, ".github/workflows/maintenance.yml");
const TAREFA = path.join(ROOT, "scripts/maintenance/elite-purge-dry-run.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "epd-"));

const { formatarResumoEpd, executar, caminhoDaBd } = await import(pathToFileURL(TAREFA).href);
const E = await import(pathToFileURL(path.join(ROOT, "lib/importer/curation/eliteCuration.server.js")).href);

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

const SEGREDO = "SEGREDO-DBG43-EPD";
const VENDOR = "MARCA-TESTE-SEM-PREMIUM";

function linhaDoCatalogo(sku) {
  return { sku, title: `Título ${SEGREDO} ${sku}`, vendor: VENDOR, categoryMain: "Juguetes", categorySegments: "[]", netPrice: 20, stock: 3 };
}
function entrada(sku, status, metadata = {}) {
  return { sku, title_en: `${SEGREDO} ${sku}`, status, reason: "teste", shopifyStatus: "DRAFT", metadata: { vendor: VENDOR, netPrice: 20, ...metadata } };
}

function escreverFila(nome, conteudo) {
  const dir = fs.mkdtempSync(path.join(tmp, `${nome}-`));
  const caminho = path.join(dir, "curation-queue.json");
  fs.writeFileSync(caminho, typeof conteudo === "string" ? conteudo : JSON.stringify({ version: 1, items: conteudo }));
  return caminho;
}

/** Cenário: 2 saem (PENDING sem origem, REJECTED de elite), 1 retido por decisão humana, 1 publicado, 1 sem entrada. */
const FILA = [
  entrada("EPD-SAI-1", "PENDING"),
  entrada("EPD-SAI-2", "REJECTED", { origem: "elite" }),
  entrada("EPD-HUM", "APPROVED", { origem: "humano", approvedAt: "2026-10-01T00:00:00.000Z" }),
  entrada("EPD-PUB", "PUBLISHED", { origem: "regra", shopifyProductId: "gid://shopify/Product/1" }),
];
const LINHAS = ["EPD-SAI-1", "EPD-SAI-2", "EPD-HUM", "EPD-PUB", "EPD-SEM"].map(linhaDoCatalogo);

/** Dependências falsas da purga. As escritas lançam: se a tarefa as chamar, o teste falha. */
function depsFalsas() {
  const chamadas = [];
  return {
    chamadas,
    dependencias: {
      async contarCatalogo() {
        return LINHAS.length;
      },
      async lerLote({ cursor }) {
        if (cursor) return [];
        return LINHAS.slice().sort((a, b) => a.sku.localeCompare(b.sku));
      },
      async apagarLote() {
        chamadas.push("apagar");
        throw new Error("escrita proibida no dry-run");
      },
      async mutarFila() {
        chamadas.push("fila");
        throw new Error("escrita proibida no dry-run");
      },
      async escreverLog() {
        chamadas.push("log");
        throw new Error("escrita proibida no dry-run");
      },
    },
  };
}

console.log("(a) formatação: só contagens");
await check("resumo tem as contagens por estado e por decisão humana, sem SKU nem texto livre", () => {
  const linhas = formatarResumoEpd({
    before: 10,
    candidatos: 3,
    retidos: 4,
    retidosPorMotivo: { decisao_humana: 2, publicado_ou_erro: 1, sem_entrada: 1 },
    candidatosPorEstado: { PENDING: 2, REJECTED: 1 },
    retidosPorEstado: { APPROVED: 2, PUBLISHED: 1, sem_entrada: 1 },
  });
  const saida = linhas.join("\n");
  assert.match(saida, /^EPD: catalogo_total=10$/m);
  assert.match(saida, /^EPD: candidatos=3$/m);
  assert.match(saida, /^EPD: retidos=4$/m);
  assert.match(saida, /^EPD: retidos_decisao_humana=2$/m);
  assert.match(saida, /^EPD: retidos_outros_motivos=2$/m);
  assert.match(saida, /^EPD: sairiam_PENDING=2$/m);
  assert.match(saida, /^EPD: sairiam_REJECTED=1$/m);
  assert.match(saida, /^EPD: retidos_APPROVED=2$/m);
  assert.match(saida, /^EPD: retidos_SYNC_ERROR=0$/m);
  for (const l of linhas) assert.match(l, /^EPD: [a-z_A-Z]+=\d+$/, `linha fora do formato chave=número: ${l}`);
});

console.log("(b) executar: dry-run, sem escrita, erros sem detalhe");
await check("executar: só contagens, nenhum SKU nem título; a fila não muda e nenhuma escrita é chamada", async () => {
  const caminho = escreverFila("ok", FILA);
  const antes = fs.readFileSync(caminho, "utf8");
  const f = depsFalsas();
  let opcoesRecebidas = null;
  const r = await executar({
    caminhoFila: caminho,
    shop: "loja-teste.myshopify.com",
    purgar: (shop, opcoes) => {
      opcoesRecebidas = opcoes;
      return E.purgeEliteCatalog(shop, { ...opcoes, dependencias: { ...f.dependencias, ...(opcoes.dependencias || {}) } });
    },
  });
  assert.equal(r.codigo, "ok", `código: ${r.codigo}`);
  assert.equal(opcoesRecebidas.executar, false, "a tarefa é sempre dry-run");
  assert.deepEqual(f.chamadas, [], "nenhuma escrita foi chamada");
  assert.equal(fs.readFileSync(caminho, "utf8"), antes, "a fila não pode mudar");
  const saida = r.linhas.join("\n");
  assert.ok(!saida.includes(SEGREDO), "a saída não pode ter SKU nem título");
  assert.match(saida, /^EPD: candidatos=2$/m);
  assert.match(saida, /^EPD: retidos_decisao_humana=1$/m);
  assert.match(saida, /^EPD: retidos_PUBLISHED=1$/m);
  assert.match(saida, /^EPD: retidos_sem_entrada=1$/m);
});
await check("fila em falta ou ilegível: para sem chamar a purga", async () => {
  let chamadas = 0;
  const purgar = async () => {
    chamadas += 1;
    return {};
  };
  let r = await executar({ caminhoFila: path.join(tmp, "nao-existe", "q.json"), shop: "x", purgar });
  assert.deepEqual(r, { codigo: "fila_em_falta", linhas: ["EPD: erro=fila_em_falta"] });
  r = await executar({ caminhoFila: escreverFila("corrompida", "{ isto não é json"), shop: "x", purgar });
  assert.deepEqual(r, { codigo: "fila_ilegivel", linhas: ["EPD: erro=fila_ilegivel"] });
  r = await executar({ caminhoFila: escreverFila("sem-items", '{"version":1}'), shop: "x", purgar });
  assert.deepEqual(r, { codigo: "fila_ilegivel", linhas: ["EPD: erro=fila_ilegivel"] });
  assert.equal(chamadas, 0);
});
await check("falha do catálogo: só o código, sem a mensagem de erro (pode trazer dados da loja)", async () => {
  const r = await executar({
    caminhoFila: escreverFila("cat", FILA),
    shop: "x",
    purgar: async () => {
      throw new Error(`Prisma: ${SEGREDO} linha 12`);
    },
  });
  assert.deepEqual(r, { codigo: "catalogo_falhou", linhas: ["EPD: erro=catalogo_falhou"] });
});

console.log("(c) maintenance.sh");
const sh = fs.readFileSync(SCRIPT_SH, "utf8");
const shSemComentarios = sh.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

/** Bloco de execução do caso (o que chama a Fly): o que contém `remote "node …"`. */
function blocoExecucao() {
  for (const m of shSemComentarios.matchAll(/\n {2}elite_purge_dry_run\)\n/g)) {
    const bloco = shSemComentarios.slice(m.index, shSemComentarios.indexOf("\n    ;;", m.index));
    if (/remote "node /.test(bloco)) return bloco;
  }
  assert.fail("bloco de execução elite_purge_dry_run em falta");
}
await check("caso elite_purge_dry_run existe na execução e no resumo, e a chamada remota é a certa", () => {
  assert.equal([...shSemComentarios.matchAll(/\n {2}elite_purge_dry_run\)\n/g)].length, 2);
  assert.match(blocoExecucao(), /remote "node scripts\/maintenance\/elite-purge-dry-run\.mjs"/);
});
await check("o bloco só lê: nenhum comando de escrita", () => {
  assert.doesNotMatch(blocoExecucao(), /--execute|db:push|migrate|snapshots create|volumes create|tags-cleanup|character-pages-sync|tagsRemove|productUpdate|metafieldsSet|sftp put|rm -|apagar|mutar/);
});
await check("elite_purge_dry_run fica fora de WRITES e na lista que recusa execute", () => {
  const linhaWrites = sh.split("\n").find((l) => l.includes("WRITES=true ;;"));
  assert.ok(linhaWrites && !linhaWrites.includes("elite_purge_dry_run"));
  assert.match(sh, /^ {2}db_flag_check \| logs_recent \| restore_dry_run \| active_vs_queue \| elite_purge_dry_run\)$/m);
});
await check("o bloco do resumo não imprime SKU: só conta EPD:", () => {
  const i = shSemComentarios.indexOf("\n  elite_purge_dry_run)\n    epd()");
  assert.ok(i > 0, "resumo em falta");
  const bloco = shSemComentarios.slice(i, shSemComentarios.indexOf("\n    ;;", i));
  assert.match(bloco, /grep -E "\^EPD: \$1="/);
  assert.doesNotMatch(bloco, /CLEAN"?\s*\|\s*grep -E "\^(?!EPD)/);
});

/** flyctl falso: o comando remoto (argumento 6) vai para o log e a saída vem de FAKE_OUT. */
function correrSh(task, phase, { saida, rc = 0, script = SCRIPT_SH }) {
  const dir = fs.mkdtempSync(path.join(tmp, "sh-"));
  const bin = path.join(dir, "flyctl");
  const log = path.join(dir, "log");
  const out = path.join(dir, "out.txt");
  const summary = path.join(dir, "summary.md");
  fs.writeFileSync(out, saida);
  fs.writeFileSync(bin, '#!/bin/sh\necho "$6" >> "$FAKE_LOG"\ncat "$FAKE_OUT"\nexit "$FAKE_RC"\n', { mode: 0o755 });
  const r = spawnSync("bash", [script, task, phase], {
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
  "EPD: catalogo_total=57",
  "EPD: candidatos=12",
  "EPD: retidos=45",
  "EPD: retidos_decisao_humana=30",
  "EPD: retidos_outros_motivos=15",
  "EPD: motivo_publicado_ou_erro=5",
  "EPD: motivo_apagado_no_admin=4",
  "EPD: motivo_reset=2",
  "EPD: motivo_decisao_humana=30",
  "EPD: motivo_sem_entrada=2",
  "EPD: motivo_sem_origem=2",
  "EPD: sairiam_PENDING=8",
  "EPD: sairiam_APPROVED=3",
  "EPD: sairiam_REJECTED=1",
  "EPD: sairiam_outro=0",
  "EPD: sairiam_SYNC_ERROR=0",
  "EPD: sairiam_sem_entrada=0",
  "EPD: sairiam_PUBLISHED=0",
  "EPD: retidos_APPROVED=20",
  "EPD: retidos_PUBLISHED=15",
  "EPD: retidos_SYNC_ERROR=2",
  "EPD: retidos_PENDING=0",
  "EPD: retidos_REJECTED=0",
  "EPD: retidos_sem_entrada=6",
  "EPD: retidos_outro=2",
  `SEGREDO-DBG43-LINHA-EM-BRUTO ${SEGREDO} sku-real-123`,
].join("\n") + "\n";

/** DBG-153: o total dos retidos tem linha própria, e a divisão por motivo vem na linha seguinte, sem 'dos quais'. */
const LINHA_TOTAL = "- Retidos: **$(en retidos)**.";
const LINHA_TOTAL_ANTIGA = "- Retidos: **$(en retidos)**, dos quais por decisão humana **$(en retidos_decisao_humana)** e por outros motivos **$(en retidos_outros_motivos)**.";
function verificarRotulo(resumo) {
  assert.match(resumo, /^- Retidos: \*\*45\*\*\.$/m, "o total dos retidos tem de vir numa linha própria");
  assert.doesNotMatch(resumo, /dos quais|por outros motivos/, "o rótulo antigo não pode voltar");
  assert.match(resumo, /^- Retidos por motivo: .*decisao_humana \*\*30\*\*.*sem_origem \*\*2\*\*\.$/m, "a divisão por motivo tem de trazer decisao_humana");
}

await check("execute é recusado para esta tarefa: código 64 e a Fly não é chamada", () => {
  const r = correrSh("elite_purge_dry_run", "execute", { saida: SAIDA_OK });
  assert.equal(r.status, 64, `código: ${r.status} (${r.stderr})`);
  assert.equal(r.calls.length, 0, "a Fly não pode ser chamada com execute");
});
await check("run dry-run com flyctl falso: resumo em contagens, sem linha em bruto, só leitura", () => {
  const r = correrSh("elite_purge_dry_run", "dry-run", { saida: SAIDA_OK });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.length, 1);
  assert.match(r.calls[0], /node scripts\/maintenance\/elite-purge-dry-run\.mjs/);
  assert.match(r.summaryText, /12 sairiam/);
  assert.match(r.summaryText, /PENDING \*\*8\*\*/);
  verificarRotulo(r.summaryText);
  assert.ok(!r.summaryText.includes(SEGREDO), "o resumo não pode ter a linha em bruto");
  assert.ok(!r.summaryText.includes("sku-real-123"), "o resumo não pode ter SKU");
  assert.ok(!r.stdout.includes(SEGREDO) && !r.stderr.includes(SEGREDO), "a consola não pode ter a linha em bruto");
});
await check("rótulo: a divisão por motivo vem numa linha própria, com n/d enquanto a app não tiver a formatação nova", () => {
  const saida = SAIDA_OK.split("\n").filter((l) => !l.startsWith("EPD: motivo_")).join("\n");
  const r = correrSh("elite_purge_dry_run", "dry-run", { saida });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.summaryText, /^- Retidos: \*\*45\*\*\.$/m);
  assert.match(r.summaryText, /^- Retidos por motivo: \*\*n\/d\*\*/m);
  assert.doesNotMatch(r.summaryText, /dos quais|por outros motivos/);
});
await check("mutação: repor o rótulo antigo no maintenance.sh faz a verificação falhar", () => {
  assert.ok(sh.includes(LINHA_TOTAL), "a linha nova não existe no maintenance.sh");
  const mutante = sh.replace(LINHA_TOTAL, () => LINHA_TOTAL_ANTIGA);
  assert.notEqual(mutante, sh, "a mutação não se aplicou");
  const dir = fs.mkdtempSync(path.join(tmp, "mutante-"));
  const script = path.join(dir, "maintenance.sh");
  fs.writeFileSync(script, mutante);
  const r = correrSh("elite_purge_dry_run", "dry-run", { saida: SAIDA_OK, script });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.summaryText, /dos quais por decisão humana \*\*30\*\*/, "o mutante tem de sair com o rótulo antigo");
  assert.throws(() => verificarRotulo(r.summaryText), "a verificação tem de falhar com o rótulo antigo");
});
await check("falha da tarefa: causa classificada, sem a saída bruta", () => {
  const r = correrSh("elite_purge_dry_run", "dry-run", { saida: "EPD: erro=fila_em_falta\n", rc: 1 });
  assert.notEqual(r.status, 0);
  assert.match(r.summaryText, /a fila de curadoria não existe no volume/);
});

console.log("(d) maintenance.yml");
const yml = fs.readFileSync(YML, "utf8");
await check("a tarefa está nas opções do workflow", () => {
  assert.match(yml, /^ {10}- elite_purge_dry_run$/m);
});
await check("o job de escrita (production) só aceita as quatro tarefas de escrita", () => {
  const linhaExecute = yml.split("\n").find((l) => l.includes("contains(fromJSON(") && l.includes("volume_snapshot"));
  assert.ok(linhaExecute, "condição do job execute em falta");
  assert.doesNotMatch(linhaExecute, /elite_purge_dry_run/);
  assert.match(linhaExecute, /\["volume_snapshot","tags_cleanup","character_pages_sync","db_push"\]/);
});

console.log("(e) guarda da BD");
await check("caminhoDaBd: absoluto fica igual; relativo resolve-se a partir de prisma/, como o Prisma", () => {
  assert.equal(caminhoDaBd({ DATABASE_URL: "file:/app/data/dev.sqlite" }), "/app/data/dev.sqlite");
  assert.equal(caminhoDaBd({ DATABASE_URL: "file:./dev.sqlite" }), path.join(ROOT, "prisma", "dev.sqlite"));
});

fs.rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.error(`\nelite-purge-dry-run: ${failures} verificação(ões) falharam`);
  process.exit(1);
}
console.log("\nelite-purge-dry-run: todos os casos passaram");
