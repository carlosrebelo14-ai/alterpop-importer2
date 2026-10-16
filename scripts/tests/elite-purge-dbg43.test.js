#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-43. A purga de elite só sai do que não tem decisão humana (PENDING, ou origem regra/elite).
 * Publicado, erro de sincronização, decisão humana, apagado no admin, reset e SKU sem entrada ficam
 * como estão, e são contados no resumo. Por omissão é um dry-run: não escreve nada. A escrita fica
 * bloqueada até OK do arquiteto, na rota da app (409 com marcador) e na CLI (--execute, código 1).
 *
 * Casos:
 *   T1   avaliarPurgaDeEntrada: tabela de decisões por entrada.
 *   T2   dry-run: o que sairia e o que ficaria retido, por motivo.
 *   T3   dry-run não escreve: nem a fila, nem o catálogo, nem o log.
 *   T4   execução: a fila é escrita antes do catálogo, e só saem os SKU elegíveis.
 *   T5   falha na fila: nada sai do catálogo (fail closed).
 *   T6   a decisão é relida sob o lock: um SKU decidido à mão entretanto fica retido.
 *   T7   a fila recebe o estado de elite (PENDING, DRAFT) nas entradas que saem.
 *   T8   decisão humana, publicado e erro de sync ficam iguais depois da execução.
 *   T9   o log final tem os retidos, os removidos e a contagem por motivo.
 *   T10  REJECTED de origem elite sai do catálogo e continua REJECTED na fila.
 *   T11  rota da app: executar responde 409 com marcador, antes de qualquer escrita.
 *   T12  CLI com --execute: código 1, mensagem de bloqueio, nada lido nem criado.
 *   T13  CLI: sem escrita (sem chamadas às funções de escrita, e dry-run por omissão).
 *   T14  as funções da purga ficam exportadas para a rota e para os testes.
 *
 * Usa dependências falsas (purgeEliteCatalog recebe `dependencias`). Não toca na BD nem na fila real.
 *
 * Uso: node scripts/tests/elite-purge-dbg43.test.js
 */
import "./_isolate-curation.js";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ELITE = pathToFileURL(path.join(RAIZ, "lib", "importer", "curation", "eliteCuration.server.js")).href;
const PURGA_DB = pathToFileURL(path.join(RAIZ, "lib", "importer", "catalog", "purgeDatabase.server.js")).href;
const ROTA = path.join(RAIZ, "app", "routes", "api.curation.elite-purge.jsx");
const CLI = path.join(RAIZ, "scripts", "curation", "elite-curation-purge.js");

const E = await import(ELITE);
const { catalogRowToEvaluateRecord } = await import(PURGA_DB);

const SHOP = "loja-teste.myshopify.com";
const VENDOR = "MARCA-TESTE-SEM-PREMIUM";

function linhaDoCatalogo(sku) {
  return { sku, title: `Produto ${sku}`, vendor: VENDOR, categoryMain: "Juguetes", categorySegments: "[]", netPrice: 20, stock: 3 };
}

function entrada(sku, status, metadata = {}) {
  return {
    sku,
    title_en: sku,
    status,
    reason: "teste",
    shopifyStatus: status === "APPROVED" ? "ACTIVE" : "DRAFT",
    metadata: { vendor: VENDOR, netPrice: 20, ...metadata },
  };
}

/**
 * Dependências falsas. `registo` guarda cada escrita, por ordem. `concorrente` (uma vez) altera a fila
 * sob o lock, como uma decisão humana que chega entre a leitura e a escrita. `falharFila` faz a
 * escrita da fila falhar.
 */
function falsas({ linhas = [], fila = [], falharFila = false, concorrente = null } = {}) {
  const registo = [];
  let filaAtual = { version: 1, items: JSON.parse(JSON.stringify(fila)) };
  let catalogo = linhas.slice();
  let pendente = concorrente;
  const dependencias = {
    limparCache() {},
    async contarCatalogo() {
      return catalogo.length;
    },
    async lerLote({ cursor }) {
      if (cursor) return [];
      return catalogo.slice().sort((a, b) => a.sku.localeCompare(b.sku));
    },
    async apagarLote({ skus }) {
      registo.push(["apagar", skus.slice()]);
      catalogo = catalogo.filter((l) => !skus.includes(l.sku));
    },
    async lerFila() {
      return JSON.parse(JSON.stringify(filaAtual));
    },
    async mutarFila(fn) {
      registo.push(["fila"]);
      if (falharFila) throw new Error("falha simulada da fila");
      if (pendente) {
        pendente(filaAtual);
        pendente = null;
      }
      const copia = JSON.parse(JSON.stringify(filaAtual));
      const { gravar, valor } = await fn(copia);
      if (gravar) filaAtual = copia;
      return valor;
    },
    async escreverLog(_shop, payload) {
      registo.push(["log", payload]);
    },
  };
  return {
    dependencias,
    registo,
    fila: () => filaAtual.items,
    catalogo: () => catalogo,
  };
}

/** Cenário comum: 2 que saem (PENDING sem origem e REJECTED de elite), 2 retidos (humano e sem entrada). */
function cenarioBase() {
  const fila = [
    entrada("L-A", "PENDING"),
    entrada("L-B", "APPROVED", { origem: "humano", approvedAt: "2026-10-01T00:00:00.000Z" }),
    entrada("L-D", "REJECTED", { origem: "elite", rejectedAt: "2026-10-01T00:00:00.000Z" }),
  ];
  const linhas = ["L-A", "L-B", "L-C", "L-D"].map(linhaDoCatalogo);
  return { fila, linhas };
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
  }
}

// ---------------------------------------------------------------------------
// T1: tabela de decisões
// ---------------------------------------------------------------------------
async function casoTabelaDeDecisoes() {
  const casos = [
    ["PENDING sem origem", entrada("x", "PENDING"), true],
    ["regra APPROVED", entrada("x", "APPROVED", { origem: "regra" }), true],
    ["elite REJECTED", entrada("x", "REJECTED", { origem: "elite" }), true],
    ["humano APPROVED", entrada("x", "APPROVED", { origem: "humano" }), false],
    ["humano PENDING", entrada("x", "PENDING", { origem: "humano" }), false],
    ["PUBLISHED de regra", entrada("x", "PUBLISHED", { origem: "regra" }), false],
    ["SYNC_ERROR de regra", entrada("x", "SYNC_ERROR", { origem: "regra" }), false],
    ["PENDING com shopifyProductId", entrada("x", "PENDING", { shopifyProductId: "gid://shopify/Product/1" }), false],
    ["PENDING apagado no admin", entrada("x", "PENDING", { deletedInAdmin: { at: "2026-10-01" } }), false],
    ["PENDING de reset", entrada("x", "PENDING", { origem: "reset" }), false],
    ["sem entrada na fila", null, false],
  ];
  for (const [nome, item, esperado] of casos) {
    const { pode } = E.avaliarPurgaDeEntrada(item);
    assert.equal(pode, esperado, `${nome}: pode=${pode}, esperado ${esperado}`);
  }
}

// ---------------------------------------------------------------------------
// T2: dry-run, o que sairia e o que ficaria retido
// ---------------------------------------------------------------------------
async function casoDryRunPorMotivo() {
  const { fila, linhas } = cenarioBase();
  // Pré-condição: as quatro linhas são de elite, senão o caso não testa nada.
  for (const l of linhas) assert.ok(E.evaluateEliteCuration(catalogRowToEvaluateRecord(l)).action, `${l.sku} não é de elite`);
  const f = falsas({ linhas, fila });
  const r = await E.purgeEliteCatalog(SHOP, { dependencias: f.dependencias });
  assert.equal(r.dryRun, true);
  assert.equal(r.candidatos, 2, `candidatos: ${r.candidatos}`);
  assert.equal(r.retidos, 2, `retidos: ${r.retidos}`);
  assert.deepEqual(r.retidosPorMotivo, { decisao_humana: 1, sem_entrada: 1 });
  assert.equal(r.removed, 0, "o dry-run não remove nada");
  assert.equal(r.previstoRestam, 2, "restariam 2 (4 - 2 candidatos)");
}

// ---------------------------------------------------------------------------
// T3: dry-run não escreve
// ---------------------------------------------------------------------------
async function casoDryRunSemEscrita() {
  const { fila, linhas } = cenarioBase();
  const f = falsas({ linhas, fila });
  const antes = JSON.stringify(f.fila());
  await E.purgeEliteCatalog(SHOP, { dependencias: f.dependencias });
  assert.deepEqual(f.registo, [], `o dry-run chamou escritas: ${JSON.stringify(f.registo.map((x) => x[0]))}`);
  assert.equal(JSON.stringify(f.fila()), antes, "a fila não pode mudar no dry-run");
  assert.equal(f.catalogo().length, linhas.length, "o catálogo não pode mudar no dry-run");
}

// ---------------------------------------------------------------------------
// T4: ordem (fila antes do catálogo) e só os SKU elegíveis
// ---------------------------------------------------------------------------
async function casoOrdemFilaAntesDoCatalogo() {
  const { fila, linhas } = cenarioBase();
  const f = falsas({ linhas, fila });
  const r = await E.purgeEliteCatalog(SHOP, { executar: true, dependencias: f.dependencias });
  const ordem = f.registo.map((x) => x[0]);
  assert.ok(ordem.indexOf("fila") >= 0 && ordem.indexOf("apagar") > ordem.indexOf("fila"), `ordem: ${ordem.join(" > ")}`);
  const apagados = f.registo.find((x) => x[0] === "apagar")[1].slice().sort();
  assert.deepEqual(apagados, ["L-A", "L-D"], "só saem os SKU elegíveis");
  assert.equal(r.removed, 2);
}

// ---------------------------------------------------------------------------
// T5: falha na fila não deixa sair nada
// ---------------------------------------------------------------------------
async function casoFilaFalhaNadaSai() {
  const { fila, linhas } = cenarioBase();
  const f = falsas({ linhas, fila, falharFila: true });
  await assert.rejects(E.purgeEliteCatalog(SHOP, { executar: true, dependencias: f.dependencias }), /falha simulada/);
  assert.equal(f.registo.filter((x) => x[0] === "apagar").length, 0, "com a fila em falha, nada sai do catálogo");
  assert.equal(f.catalogo().length, linhas.length, "o catálogo fica igual");
}

// ---------------------------------------------------------------------------
// T6: decisão tomada entre a leitura e a escrita fica retida
// ---------------------------------------------------------------------------
async function casoDecisaoRelidaSobOLock() {
  const { fila, linhas } = cenarioBase();
  const concorrente = (filaAtual) => {
    const a = filaAtual.items.find((i) => i.sku === "L-A");
    a.status = "APPROVED";
    a.shopifyStatus = "ACTIVE";
    a.metadata = { ...a.metadata, origem: "humano", approvedAt: "2026-10-16T00:00:00.000Z" };
  };
  const f = falsas({ linhas, fila, concorrente });
  const r = await E.purgeEliteCatalog(SHOP, { executar: true, dependencias: f.dependencias });
  const apagados = f.registo.find((x) => x[0] === "apagar")[1];
  assert.deepEqual(apagados, ["L-D"], "L-A foi decidido à mão: não pode sair");
  assert.equal(r.retidosPorMotivo.decisao_mudou, 1, "a mudança sob o lock conta como retido");
  assert.equal(f.fila().find((i) => i.sku === "L-A").status, "APPROVED", "a decisão humana não pode ser reescrita");
}

// ---------------------------------------------------------------------------
// T7: entradas que saem ficam com o estado de elite na fila
// ---------------------------------------------------------------------------
async function casoFilaComEstadoDeElite() {
  const fila = [entrada("P-1", "PENDING"), entrada("R-1", "APPROVED", { origem: "regra" })];
  const linhas = ["P-1", "R-1"].map(linhaDoCatalogo);
  const f = falsas({ linhas, fila });
  await E.purgeEliteCatalog(SHOP, { executar: true, dependencias: f.dependencias });
  const r1 = f.fila().find((i) => i.sku === "R-1");
  assert.equal(r1.status, "PENDING", "APPROVED de regra, marcado pela elite, volta a PENDING");
  assert.equal(r1.shopifyStatus, "DRAFT");
  assert.equal(r1.metadata.eliteCuration, true);
  assert.equal(r1.metadata.eliteAction, "PENDING_MANUAL");
}

// ---------------------------------------------------------------------------
// T8: decisão humana, publicado e erro de sync ficam iguais
// ---------------------------------------------------------------------------
async function casoProtegidosFicamIguais() {
  const fila = [
    entrada("H-1", "APPROVED", { origem: "humano", approvedAt: "2026-10-01T00:00:00.000Z" }),
    entrada("PB-1", "PUBLISHED", { origem: "regra", shopifyProductId: "gid://shopify/Product/9" }),
    entrada("SE-1", "SYNC_ERROR", { origem: "regra" }),
  ];
  const linhas = ["H-1", "PB-1", "SE-1"].map(linhaDoCatalogo);
  const antes = JSON.stringify(fila);
  const f = falsas({ linhas, fila });
  const r = await E.purgeEliteCatalog(SHOP, { executar: true, dependencias: f.dependencias });
  assert.equal(JSON.stringify(f.fila()), antes, "humano, publicado e erro de sync ficam como estão");
  assert.equal(r.removed, 0, "nenhum destes sai do catálogo");
  assert.equal(r.retidos, 3, `retidos: ${r.retidos}`);
  assert.equal(f.catalogo().length, 3);
}

// ---------------------------------------------------------------------------
// T9: o log final tem os retidos e os removidos
// ---------------------------------------------------------------------------
async function casoLogComRetidos() {
  const { fila, linhas } = cenarioBase();
  const f = falsas({ linhas, fila });
  const r = await E.purgeEliteCatalog(SHOP, { executar: true, dependencias: f.dependencias });
  const log = f.registo.find((x) => x[0] === "log")[1];
  assert.equal(log.removed, r.removed);
  assert.equal(log.retidos, 2, "o log conta os retidos");
  assert.deepEqual(log.retidosPorMotivo, { decisao_humana: 1, sem_entrada: 1 });
  assert.equal(typeof log.filaAlteradas, "number");
}

// ---------------------------------------------------------------------------
// T10: REJECTED de elite sai do catálogo e continua REJECTED
// ---------------------------------------------------------------------------
async function casoRejectedDeEliteSai() {
  const { fila, linhas } = cenarioBase();
  const f = falsas({ linhas, fila });
  await E.purgeEliteCatalog(SHOP, { executar: true, dependencias: f.dependencias });
  assert.equal(f.catalogo().some((l) => l.sku === "L-D"), false, "L-D sai do catálogo");
  assert.equal(f.fila().find((i) => i.sku === "L-D").status, "REJECTED", "L-D continua REJECTED na fila");
}

// ---------------------------------------------------------------------------
// T11: a rota responde 409 com marcador antes de qualquer escrita
// ---------------------------------------------------------------------------
function casoRotaBloqueiaExecucao() {
  const codigo = fs.readFileSync(ROTA, "utf8");
  assert.match(codigo, /body\?\.executar === true/, "a rota tem de ler executar");
  const bloqueio = codigo.indexOf("status: 409");
  assert.ok(bloqueio > 0, "a rota tem de responder 409");
  assert.match(codigo, /\[elite-purge\]/, "o 409 tem a marca [elite-purge]");
  const chamada = codigo.indexOf("purgeEliteCatalog(session.shop, { executar: false })");
  assert.ok(chamada > bloqueio, "a purga só corre em dry-run, depois do bloqueio");
  assert.doesNotMatch(codigo, /purgeEliteCatalog\([^)]*executar:\s*true/, "a rota nunca passa executar: true à purga");
}

// ---------------------------------------------------------------------------
// T12: CLI com --execute sai com 1 e não lê nem cria nada
// ---------------------------------------------------------------------------
function casoCliExecutarRecusado() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "elite-cli-"));
  try {
    const r = spawnSync(process.execPath, [CLI, "--execute"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
      env: { PATH: process.env.PATH, CURATION_DATA_DIR: dir, DATABASE_URL: `file:${path.join(dir, "dev.sqlite")}` },
    });
    assert.equal(r.status, 1, `código de saída (sinal ${r.signal}): ${r.stderr}`);
    assert.match(r.stderr, /bloqueada até OK do arquiteto \(DBG-43\)/);
    assert.doesNotMatch(r.stdout, /Loja:/, "a recusa vem antes de carregar a loja");
    assert.deepEqual(fs.readdirSync(dir), [], "nada foi criado no diretório");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// T13: a CLI não escreve e corre em dry-run por omissão
// ---------------------------------------------------------------------------
function casoCliSemEscrita() {
  const codigo = fs.readFileSync(CLI, "utf8");
  for (const termo of ["apagarLote", "mutarFila", "mutateCurationQueue", "deleteMany", "escreverLog", "writeFile"]) {
    assert.doesNotMatch(codigo, new RegExp(termo), `a CLI não pode chamar ${termo}`);
  }
  assert.match(codigo, /purgeEliteCatalog\(shop, \{ executar: false \}\)/, "a CLI corre em dry-run");
}

// ---------------------------------------------------------------------------
// T14: exportações
// ---------------------------------------------------------------------------
function casoExportacoes() {
  for (const nome of ["purgeEliteCatalog", "avaliarPurgaDeEntrada", "aplicarPurgaNaFila", "readElitePurgeLog"]) {
    assert.equal(typeof E[nome], "function", `${nome} tem de estar exportada`);
  }
}

async function main() {
  console.log("elite-purge-dbg43");
  await caso("T1  tabela de decisões por entrada", casoTabelaDeDecisoes);
  await caso("T2  dry-run: o que sairia e o que ficaria retido, por motivo", casoDryRunPorMotivo);
  await caso("T3  dry-run não escreve: fila, catálogo e log ficam iguais", casoDryRunSemEscrita);
  await caso("T4  execução: a fila é escrita antes do catálogo, e só saem os elegíveis", casoOrdemFilaAntesDoCatalogo);
  await caso("T5  falha na fila: nada sai do catálogo", casoFilaFalhaNadaSai);
  await caso("T6  decisão tomada entre a leitura e a escrita fica retida", casoDecisaoRelidaSobOLock);
  await caso("T7  entradas que saem ficam com o estado de elite na fila", casoFilaComEstadoDeElite);
  await caso("T8  decisão humana, publicado e erro de sync ficam iguais", casoProtegidosFicamIguais);
  await caso("T9  o log final tem os retidos e os removidos", casoLogComRetidos);
  await caso("T10 REJECTED de elite sai do catálogo e continua REJECTED", casoRejectedDeEliteSai);
  await caso("T11 rota da app: executar responde 409 com marcador", casoRotaBloqueiaExecucao);
  await caso("T12 CLI com --execute: código 1, nada lido nem criado", casoCliExecutarRecusado);
  await caso("T13 CLI sem escrita, e dry-run por omissão", casoCliSemEscrita);
  await caso("T14 funções da purga exportadas", casoExportacoes);

  console.log("\nRESUMO");
  for (const r of resultados) console.log(`  ${r.resultado.padEnd(6)} ${r.nome}`);
  const nao = resultados.filter((r) => r.resultado !== "passa").length;
  if (nao) {
    console.error(`\n${nao} caso(s) não passam`);
    process.exit(1);
  }
  console.log("\nelite-purge-dbg43: todos os casos passaram");
}

await main();
