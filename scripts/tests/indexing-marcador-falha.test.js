#!/usr/bin/env node
/* eslint-env node */
/**
 * Lote 2b-1, F4 (lente de regras). Se o marcador de atividade da indexação não se consegue gravar,
 * a indexação não fica a correr. O worker é parado, o estado fica falhado com mensagem clara, e a
 * chamada não lança. Nem o caminho com `void` (startCatalogRebuildInBackground) deixa rejeição sem
 * tratamento.
 *
 * CURATION_DATA_DIR aponta para uma pasta legível e vazia, para a guarda de script passar. A escrita de
 * ficheiros catalog-busy-* falha por monkeypatch, como no caso (u) do dbg140. Uma pasta que não se lê é outro
 * caso: a guarda recusa antes do marcador (causa pasta, coberto no dbg140-141). PROJECT_ROOT aponta para um
 * diretório temporário, para o estado de indexação não ir para data/ do repositório.
 *
 * Atenção. O worker é criado (fork) antes do marcador, porque o marcador leva o pid do worker. O filho
 * recebe SIGTERM logo a seguir. O teste verifica que nenhuma indexação fica ativa.
 *
 * Uso: node scripts/tests/indexing-marcador-falha.test.js
 */
import "./_isolate-curation.js";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "indexacao-marcador-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

// Pasta de marcadores legível e vazia: a guarda de script lê sem encontrar marcadores e passa.
const dadosDoMarcador = path.join(tmp, "dados");
fs.mkdirSync(dadosDoMarcador);

// Antes de importar os módulos. O estado de indexação lê PROJECT_ROOT ao carregar, e o marcador lê
// CURATION_DATA_DIR ao chamar.
process.env.PROJECT_ROOT = path.join(tmp, "projeto");
process.env.CURATION_DATA_DIR = dadosDoMarcador;

// A escrita do marcador falha. O resto das escritas segue normal (o estado de indexação também usa fs).
const escreverFicheiro = fs.writeFileSync;
fs.writeFileSync = (ficheiro, conteudo, opcoes) => {
  if (String(ficheiro).includes("catalog-busy-")) throw new Error("disco cheio (teste)");
  return escreverFicheiro(ficheiro, conteudo, opcoes);
};
process.on("exit", () => {
  fs.writeFileSync = escreverFicheiro;
});

const modulo = (rel) => import(pathToFileURL(path.join(RAIZ, rel)).href);
const indexacao = await modulo("lib/importer/catalog/indexingStream.server.js");
const estado = await modulo("lib/importer/catalog/catalogRebuildStatus.server.js");

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

await caso("sem marcador possível: a chamada não lança, não deixa indexação ativa e o estado fica falhado", async () => {
  const devolvido = await indexacao.startCatalogIndexingWorker("loja-marcador.myshopify.com", {}, { causa: "painel" });
  assert.equal(devolvido, null, "devolve null, sem lançar");
  assert.equal(indexacao.isCatalogIndexingRunning("loja-marcador.myshopify.com"), false, "não pode ficar indexação ativa");

  const emMemoria = estado.getInMemoryStatus("loja-marcador.myshopify.com");
  assert.equal(emMemoria?.state, "failed", "o estado em memória tem de ficar falhado");
  assert.equal(emMemoria?.indexing, false);
  assert.match(emMemoria?.error ?? "", /marcar a atividade da app/);

  const emDisco = await estado.readCatalogRebuildStatusFromDisk("loja-marcador.myshopify.com");
  assert.equal(emDisco?.state, "failed", "o estado falhado também vai a disco");
  assert.match(emDisco?.error ?? "", /marcar a atividade da app/);
});

await caso("caminho com void (startCatalogRebuildInBackground) não deixa rejeição sem tratamento", async () => {
  const rejeicoes = [];
  const ouvinte = (motivo) => rejeicoes.push(motivo);
  process.on("unhandledRejection", ouvinte);
  try {
    indexacao.startCatalogRebuildInBackground("loja-void.myshopify.com", {});
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    process.off("unhandledRejection", ouvinte);
  }
  assert.deepEqual(rejeicoes.map(String), [], "nenhuma rejeição pode ficar sem tratamento");
});

if (falhas) {
  console.error(`\n${falhas} falha(s)`);
  process.exit(1);
}
console.log("\nindexing-marcador-falha: todos os casos passaram");
