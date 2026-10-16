#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-04, decisão 1 do arquiteto (fairness do lock). Os scripts que escrevem a fila tomam o lock de
 * ficheiro uma vez por lote, e não uma vez por registo.
 *
 * Casos:
 *   L1  comLockDaFila com N aprovações: uma só aquisição do lock, e todas as aprovações gravadas.
 *   L2  Importação em fluxo (runStreamImport) com N registos: no máximo uma aquisição por lote de
 *       escrita (LOTE_DA_FILA), e todos os registos ficam na fila.
 *   L3  Os scripts de escrita em loop (requeue-deleted, mark-deleted, price-reconcile-apply) têm o
 *       loop de escrita dentro de comLockDaFila(). Leitura do código sem comentários.
 *
 * Usa CURATION_DATA_DIR e uma CSV temporária (OCIOSTOCK_CSV_PATH). Não toca nos dados reais.
 *
 * Uso: node scripts/tests/curation-queue-lote-lock.test.js
 */
import "./_isolate-curation.js";

import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { semComentarios } from "./_sem-comentarios.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");
const DATA_DIR = process.env.CURATION_DATA_DIR;
const QUEUE_PATH = path.join(DATA_DIR, "curation-queue.json");
const QUEUE_MODULE = pathToFileURL(path.join(REPO, "lib", "curation", "curationQueue.server.js")).href;
const STREAM_MODULE = pathToFileURL(path.join(REPO, "lib", "importer", "core", "streamImport.js")).href;

const q = await import(QUEUE_MODULE);
const { runStreamImport } = await import(STREAM_MODULE);

const AGORA = new Date().toISOString();

function item(sku, status = "PENDING") {
  return {
    sku,
    title_en: sku,
    status,
    reason: "teste_lote_lock",
    shopifyStatus: "DRAFT",
    metadata: { vendor: "TESTVENDOR", category: "Toys", approvedAt: null, rejectedAt: null, queuedAt: AGORA },
  };
}

function escreverFila(items) {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify({ version: 1, updatedAt: null, items }), "utf8");
  q.invalidateCurationMemoryCache();
}

/** Conta as aquisições do lock de ficheiro feitas durante fn. */
async function contarAquisicoes(fn) {
  let total = 0;
  q.setLockAcquisitionObserverForTests(() => {
    total += 1;
  });
  try {
    await fn();
  } finally {
    q.setLockAcquisitionObserverForTests(null);
  }
  return total;
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
// L1: uma aquisição para um lote de aprovações
// ---------------------------------------------------------------------------
async function casoLoteDeAprovacoesUmaAquisicao() {
  const N = 30;
  const skus = Array.from({ length: N }, (_, i) => `L1-${String(i).padStart(3, "0")}`);
  escreverFila(skus.map((sku) => item(sku)));
  const aquisicoes = await contarAquisicoes(() =>
    q.comLockDaFila(async () => {
      for (const sku of skus) await q.approveProduct(sku);
    })
  );
  assert.equal(aquisicoes, 1, `aquisições do lock para ${N} aprovações: ${aquisicoes}`);
  const doDisco = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8")).items;
  const aprovados = doDisco.filter((i) => i.status === "APPROVED").length;
  assert.equal(aprovados, N, "todas as aprovações do lote têm de ficar gravadas");
}

// ---------------------------------------------------------------------------
// L2: importação em fluxo, um lock por lote de escrita
// ---------------------------------------------------------------------------
function linhaCsv(i) {
  const sku = `IMP-${String(i).padStart(4, "0")}`;
  return [sku, `Produto ${i}`, "Juguetes", "TESTMARCA", "10,00", "12,10", "8,00", "5", "1", "", "", "", "", "", "", "", "", ""].join(";");
}

async function casoImportacaoUmLockPorLote() {
  const N = 120;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lote-lock-csv-"));
  const csv = path.join(dir, "feed.csv");
  const cabecalho = "referencia;nombre;categoria_principal;marca;precio_neto;precio_bruto;precio_distribuidores;stock_disponible;hay_stock;peso;id_producto;url_imagen_principal;url_imagen_principal_grande;disponibilidad;tipo_promocion;descripcion;ean;peso_kg";
  fs.writeFileSync(csv, [cabecalho, ...Array.from({ length: N }, (_, i) => linhaCsv(i + 1))].join("\n"), "utf8");
  const anterior = process.env.OCIOSTOCK_CSV_PATH;
  process.env.OCIOSTOCK_CSV_PATH = csv;
  escreverFila([]);
  const job = {
    resultsDir: path.join(dir, "results"),
    metrics: {},
    recordSkipped() {},
    recordValidationSkipped() {},
    recordBatchComplete() {},
    recordError() {},
  };
  let resultado = null;
  try {
    const aquisicoes = await contarAquisicoes(async () => {
      resultado = await runStreamImport({
        job,
        syncProducts: false,
        syncInventory: false,
        settings: { translateToEnglish: false, autoGlossaryTranslation: false, titleApiFallback: false },
        validationOpts: { syncPrices: false },
      });
    });
    const { LOTE_DA_FILA } = await import(pathToFileURL(path.join(HERE, "..", "..", "lib", "importer", "core", "streamImport.js")).href);
    const loteMaximo = Math.ceil(N / LOTE_DA_FILA);
    assert.ok(aquisicoes >= 1, "a importação tem de escrever na fila");
    assert.ok(aquisicoes <= loteMaximo, `aquisições do lock: ${aquisicoes} para ${N} registos (máximo ${loteMaximo}, um por lote)`);
    const doDisco = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8")).items;
    assert.equal(doDisco.length, N, `registos na fila: ${doDisco.length} de ${N} (importação: ${JSON.stringify(resultado)})`);
  } finally {
    if (anterior === undefined) delete process.env.OCIOSTOCK_CSV_PATH;
    else process.env.OCIOSTOCK_CSV_PATH = anterior;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// L3: os scripts de escrita em loop têm o loop dentro de comLockDaFila
// ---------------------------------------------------------------------------
const SCRIPTS_DE_LOTE = [
  { ficheiro: "scripts/catalog/curation-requeue-deleted.js", escrita: "markQueueItemDeletedInAdmin(item.sku)" },
  { ficheiro: "scripts/catalog/curation-mark-deleted.js", escrita: "markQueueItemDeletedInAdmin(r.sku)" },
  { ficheiro: "scripts/catalog/price-reconcile-apply.js", escrita: "recordPriceWrite({" },
];

/** Posição do parêntese que fecha o que abre em `abre` (posição de "("). Sem texto de strings com parênteses. */
function fechoDoParentese(codigo, abre) {
  let profundidade = 0;
  for (let i = abre; i < codigo.length; i += 1) {
    if (codigo[i] === "(") profundidade += 1;
    else if (codigo[i] === ")") {
      profundidade -= 1;
      if (profundidade === 0) return i;
    }
  }
  return -1;
}

function casoScriptsTemLoteComLock() {
  for (const { ficheiro, escrita } of SCRIPTS_DE_LOTE) {
    const codigo = semComentarios(fs.readFileSync(path.join(REPO, ficheiro), "utf8"));
    const inicio = codigo.indexOf("comLockDaFila(");
    assert.ok(inicio >= 0, `${ficheiro}: falta comLockDaFila(`);
    const posicaoEscrita = codigo.indexOf(escrita);
    assert.ok(posicaoEscrita > inicio, `${ficheiro}: a escrita por registo tem de estar dentro de comLockDaFila(`);
    assert.equal(codigo.indexOf(escrita, posicaoEscrita + 1), -1, `${ficheiro}: a escrita por registo aparece mais de uma vez`);
    const fechoDaSeccao = fechoDoParentese(codigo, inicio + "comLockDaFila".length);
    assert.ok(fechoDaSeccao > posicaoEscrita, `${ficheiro}: a escrita não está dentro da secção de lote`);
  }
}

// ---------------------------------------------------------------------------
// L4 (DBG-46A): importação em fluxo, uma escrita da fila por lote (não por registo)
// ---------------------------------------------------------------------------
async function casoImportacaoUmaEscritaPorLote() {
  const N = 120;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lote-escrita-csv-"));
  const csv = path.join(dir, "feed.csv");
  const cabecalho = "referencia;nombre;categoria_principal;marca;precio_neto;precio_bruto;precio_distribuidores;stock_disponible;hay_stock;peso;id_producto;url_imagen_principal;url_imagen_principal_grande;disponibilidad;tipo_promocion;descripcion;ean;peso_kg";
  fs.writeFileSync(csv, [cabecalho, ...Array.from({ length: N }, (_, i) => linhaCsv(i + 1))].join("\n"), "utf8");
  const anterior = process.env.OCIOSTOCK_CSV_PATH;
  process.env.OCIOSTOCK_CSV_PATH = csv;
  escreverFila([]);
  const job = {
    resultsDir: path.join(dir, "results"),
    metrics: {},
    recordSkipped() {},
    recordValidationSkipped() {},
    recordBatchComplete() {},
    recordError() {},
  };
  const renomear = fsp.rename;
  let escritasDaFila = 0;
  fsp.rename = async (origem, destino) => {
    if (path.resolve(String(destino)) === path.resolve(QUEUE_PATH)) escritasDaFila += 1;
    return renomear(origem, destino);
  };
  try {
    await runStreamImport({
      job,
      syncProducts: false,
      syncInventory: false,
      settings: { translateToEnglish: false, autoGlossaryTranslation: false, titleApiFallback: false },
      validationOpts: { syncPrices: false },
    });
    const { LOTE_DA_FILA } = await import(pathToFileURL(path.join(HERE, "..", "..", "lib", "importer", "core", "streamImport.js")).href);
    const loteMaximo = Math.ceil(N / LOTE_DA_FILA);
    assert.ok(escritasDaFila >= 1, "a importação tem de escrever na fila");
    assert.ok(escritasDaFila <= loteMaximo, `escritas da fila: ${escritasDaFila} para ${N} registos (máximo ${loteMaximo}, uma por lote)`);
    const doDisco = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8")).items;
    assert.equal(doDisco.length, N, `registos na fila: ${doDisco.length} de ${N}`);
  } finally {
    fsp.rename = renomear;
    if (anterior === undefined) delete process.env.OCIOSTOCK_CSV_PATH;
    else process.env.OCIOSTOCK_CSV_PATH = anterior;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// L5 (DBG-46A): o lote dá o mesmo estado da fila que o registo a registo
// ---------------------------------------------------------------------------
function registoDeTeste(sku) {
  return {
    sku,
    title: `Produto ${sku}`,
    category: "Juguetes",
    categoryMain: "Juguetes",
    brand: "TESTMARCA",
    price: 10,
    priceNet: 10,
    _source: { title: `Producto ${sku}` },
  };
}

function itemDeDecisaoHumana(sku, status) {
  return { ...item(sku, status), statusChangedAt: AGORA, metadata: { ...item(sku, status).metadata, origem: "humano", approvedAt: AGORA } };
}

/** Troca as datas (que mudam a cada execução) por um marcador, para comparar só o conteúdo. */
function semDatas(valor) {
  return JSON.parse(JSON.stringify(valor, (_, v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? "<data>" : v)));
}

async function estadoDaFilaAposRegistos(inicial, registos, via) {
  escreverFila(JSON.parse(JSON.stringify(inicial)));
  const copias = JSON.parse(JSON.stringify(registos));
  if (via === "um a um") {
    for (const registo of copias) await q.upsertCurationQueueFromRecord(registo);
  } else {
    await q.upsertCurationQueueBatchFromRecords(copias);
  }
  const doDisco = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8")).items;
  return semDatas(doDisco.sort((a, b) => a.sku.localeCompare(b.sku)));
}

async function casoLoteIgualAoRegistoARegisto() {
  const inicial = [
    item("L5-PEN"),
    itemDeDecisaoHumana("L5-APR", "APPROVED"),
    item("L5-SYN", "SYNC_ERROR"),
    item("L5-PUB", "PUBLISHED"),
    item("L5-REJ", "REJECTED"),
    // DBG-89: item não fixado com campos que só o disco escreve. O lote tem de os manter, como o caminho unitário.
    { ...item("L5-DISCO"), metadata: { ...item("L5-DISCO").metadata, shopifyProductId: "gid://shopify/Product/7", lastElitePurgeAt: AGORA, overrides: { price: 9 } } },
  ];
  const registos = ["L5-NOVO-1", "L5-NOVO-2", "L5-PEN", "L5-APR", "L5-SYN", "L5-PUB", "L5-REJ", "L5-DISCO"].map(registoDeTeste);
  const umAUm = await estadoDaFilaAposRegistos(inicial, registos, "um a um");
  const lote = await estadoDaFilaAposRegistos(inicial, registos, "lote");
  assert.equal(lote.length, umAUm.length, "o lote tem de deixar o mesmo número de itens");
  assert.deepEqual(lote, umAUm, "o lote tem de deixar o mesmo estado que o registo a registo");
}

async function main() {
  await caso("L1  comLockDaFila com N aprovações: uma aquisição do lock", casoLoteDeAprovacoesUmaAquisicao);
  await caso("L2  importação em fluxo: no máximo uma aquisição por lote de escrita", casoImportacaoUmLockPorLote);
  await caso("L3  scripts de escrita em loop: o loop está dentro de comLockDaFila", casoScriptsTemLoteComLock);
  await caso("L4  importação em fluxo: no máximo uma escrita da fila por lote", casoImportacaoUmaEscritaPorLote);
  await caso("L5  lote e registo a registo deixam o mesmo estado da fila", casoLoteIgualAoRegistoARegisto);

  console.log("\nRESUMO");
  for (const r of resultados) console.log(`  ${r.resultado.padEnd(6)} ${r.nome}`);
  const nao = resultados.filter((r) => r.resultado !== "passa").length;
  if (nao) {
    console.error(`\n${nao} caso(s) não passam`);
    process.exit(1);
  }
  console.log("\ncuration-queue-lote-lock: todos os casos passaram");
}

await main();
