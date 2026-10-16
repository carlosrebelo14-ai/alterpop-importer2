#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-73 (PR 2b-2). O dry-run não grava a fila de curadoria.
 *
 * Casos:
 *   D1  Importação em fluxo em dry-run (job.mode DRY_RUN): o ficheiro da fila tem o mesmo conteúdo antes e depois.
 *   D2  ProductImporter.upsertOne em dry-run: o ficheiro da fila tem o mesmo conteúdo antes e depois.
 *   D3  Controlo: a mesma importação em live grava a fila. Sem este caso, D1 podia passar por a fila nunca ser escrita.
 *
 * Usa CURATION_DATA_DIR e uma CSV temporária (OCIOSTOCK_CSV_PATH). Não toca nos dados reais.
 *
 * Uso: node scripts/tests/dbg73-dry-run-nao-grava-fila.test.js
 */
import "./_isolate-curation.js";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");
const DATA_DIR = process.env.CURATION_DATA_DIR;
const QUEUE_PATH = path.join(DATA_DIR, "curation-queue.json");

const q = await import(pathToFileURL(path.join(REPO, "lib", "curation", "curationQueue.server.js")).href);
const { runStreamImport } = await import(pathToFileURL(path.join(REPO, "lib", "importer", "core", "streamImport.js")).href);
const { ProductImporter } = await import(pathToFileURL(path.join(REPO, "lib", "importer", "importers", "ProductImporter.js")).href);

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

const SETTINGS = { translateToEnglish: false, autoGlossaryTranslation: false, titleApiFallback: false };

function escreverFilaVazia() {
  fs.writeFileSync(QUEUE_PATH, JSON.stringify({ version: 1, updatedAt: null, items: [] }), "utf8");
  q.invalidateCurationMemoryCache();
}
const lerFila = () => fs.readFileSync(QUEUE_PATH, "utf8");

function linhaCsv(i) {
  const sku = `DRY-${String(i).padStart(4, "0")}`;
  return [sku, `Produto ${i}`, "Juguetes", "TESTMARCA", "10,00", "12,10", "8,00", "5", "1", "", "", "", "", "", "", "", "", ""].join(";");
}

function jobDe(mode) {
  const base = {
    ...(mode ? { mode } : {}),
    metrics: {},
  };
  // Os registos de progresso e de erro do job são no-op nestes testes. Qualquer método record* é aceite.
  return new Proxy(base, {
    get: (alvo, prop) => (prop in alvo || typeof prop !== "string" || !prop.startsWith("record") ? alvo[prop] : () => {}),
  });
}

/** Importação em fluxo sobre uma CSV temporária de N registos. */
async function importarCsv(job, N) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg73-csv-"));
  const csv = path.join(dir, "feed.csv");
  const cabecalho = "referencia;nombre;categoria_principal;marca;precio_neto;precio_bruto;precio_distribuidores;stock_disponible;hay_stock;peso;id_producto;url_imagen_principal;url_imagen_principal_grande;disponibilidad;tipo_promocion;descripcion;ean;peso_kg";
  fs.writeFileSync(csv, [cabecalho, ...Array.from({ length: N }, (_, i) => linhaCsv(i + 1))].join("\n"), "utf8");
  const anterior = process.env.OCIOSTOCK_CSV_PATH;
  process.env.OCIOSTOCK_CSV_PATH = csv;
  try {
    return await runStreamImport({ job: { ...job, resultsDir: path.join(dir, "results") }, syncProducts: false, syncInventory: false, settings: SETTINGS, validationOpts: { syncPrices: false } });
  } finally {
    if (anterior === undefined) delete process.env.OCIOSTOCK_CSV_PATH;
    else process.env.OCIOSTOCK_CSV_PATH = anterior;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

await caso("D1 importação em fluxo em dry-run: o ficheiro da fila fica igual", async () => {
  escreverFilaVazia();
  const antes = lerFila();
  await importarCsv(jobDe("DRY_RUN"), 5);
  assert.equal(lerFila(), antes, "o dry-run não pode alterar o ficheiro da fila");
  assert.equal(JSON.parse(lerFila()).items.length, 0, "o dry-run não pode criar entradas na fila");
});

await caso("D2 ProductImporter.upsertOne em dry-run: o ficheiro da fila fica igual", async () => {
  escreverFilaVazia();
  const antes = lerFila();
  const job = jobDe("DRY_RUN");
  const importador = new ProductImporter(job, null, SETTINGS);
  const registo = { sku: "DRY-UPS", title: "Produto DRY-UPS", vendor: "TESTMARCA", categoryMain: "Juguetes", netPrice: 10, grossPrice: 12.1, availableQuantity: 5 };
  try {
    await importador.upsertOne(registo);
  } catch (err) {
    // O resto do fluxo de produto pode falhar sem Shopify, depois do ponto de escrita da fila. O que o teste mede é a fila.
    console.log(`      (aviso: upsertOne falhou depois da fila: ${err.message})`);
  }
  assert.equal(lerFila(), antes, "o upsert em dry-run não pode gravar a entrada na fila");
});

await caso("D3 controlo: a mesma importação em live grava a fila", async () => {
  escreverFilaVazia();
  await importarCsv(jobDe(undefined), 5);
  const items = JSON.parse(lerFila()).items;
  assert.ok(items.length > 0, "em live a fila tem de ser escrita, senão o teste D1 não prova nada");
});

if (falhas) {
  console.error(`\n${falhas} falha(s)`);
  process.exit(1);
}
console.log("\ndbg73-dry-run-nao-grava-fila: todos os casos passaram");
