#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-94. Uma purga que rejeita um PENDING sem origem grava a origem elite. Com a linha do catálogo a não sair,
 * a purga seguinte reconhece o item como candidato, e não o retém como sem_origem. A purga não grava statusChangedAt.
 *
 * A rejeição da purga é AUTO_REJECT, e a regra estruturada só o dá a uma marca bloqueada. A lista de marcas
 * bloqueadas lê-se de server/data/exclude-list.json sob PROJECT_ROOT, e fica em cache na primeira leitura. Por isso o
 * teste aponta PROJECT_ROOT para um diretório temporário, com uma marca de teste, antes de importar o módulo.
 *
 * Uso: node scripts/tests/elite-purge-origem-elite.test.js
 */
import "./_isolate-curation.js";

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MARCA = "MARCA-BLOQUEADA-DBG94";
const SHOP = "loja-teste.myshopify.com";

const projeto = fs.mkdtempSync(path.join(os.tmpdir(), "elite-origem-"));
fs.mkdirSync(path.join(projeto, "server", "data"), { recursive: true });
fs.writeFileSync(path.join(projeto, "server", "data", "exclude-list.json"), JSON.stringify({ blockedBrands: [MARCA] }), "utf8");
process.env.PROJECT_ROOT = projeto;

const E = await import(pathToFileURL(path.join(RAIZ, "lib", "importer", "curation", "eliteCuration.server.js")).href);
const { catalogRowToEvaluateRecord } = await import(pathToFileURL(path.join(RAIZ, "lib", "importer", "catalog", "purgeDatabase.server.js")).href);

const linha = { sku: "ORI-1", title: "Teste", vendor: MARCA, categoryMain: "Juguetes", categorySegments: "[]", netPrice: 20, stock: 3 };
const filaInicial = [
  { sku: "ORI-1", title_en: "Teste", status: "PENDING", shopifyStatus: "DRAFT", reason: "pending", metadata: { vendor: MARCA, netPrice: 20 } },
];

/** Dependências falsas. A purga não remove a linha: a rejeição fica na fila e a linha continua no catálogo. */
function falsas(fila, linhas) {
  let filaAtual = { version: 1, items: JSON.parse(JSON.stringify(fila)) };
  return {
    fila: () => filaAtual.items,
    dependencias: {
      async contarCatalogo() {
        return linhas.length;
      },
      async lerLote({ cursor }) {
        if (cursor) return [];
        return linhas.slice().sort((a, b) => a.sku.localeCompare(b.sku));
      },
      async apagarLote() {},
      async lerFila() {
        return JSON.parse(JSON.stringify(filaAtual));
      },
      async mutarFila(fn) {
        const copia = JSON.parse(JSON.stringify(filaAtual));
        const { gravar, valor } = await fn(copia);
        if (gravar) filaAtual = copia;
        return valor;
      },
      async escreverLog() {},
    },
  };
}

let falhas = 0;
async function check(nome, fn) {
  try {
    await fn();
    console.log(`  ok  ${nome}`);
  } catch (err) {
    falhas += 1;
    console.error(`FAIL  ${nome}\n      ${err.message}`);
  }
}

console.log("elite-purge-origem-elite");

await check("pré-condição: a linha do catálogo dá AUTO_REJECT pela marca bloqueada", () => {
  const elite = E.evaluateEliteCuration(catalogRowToEvaluateRecord(linha));
  assert.equal(elite.action, "AUTO_REJECT", `a pré-condição falhou: ${JSON.stringify(elite)}`);
});

await check("a purga rejeita o PENDING sem origem, com origem elite e sem statusChangedAt", async () => {
  const f = falsas(filaInicial, [linha]);
  await E.purgeEliteCatalog(SHOP, { executar: true, dependencias: f.dependencias });
  const item = f.fila().find((i) => i.sku === "ORI-1");
  assert.equal(item.status, "REJECTED", "a purga rejeita o item");
  assert.equal(item.metadata.origem, "elite", "a rejeição da purga grava a origem elite");
  assert.equal(item.statusChangedAt, undefined, "a purga não grava statusChangedAt");
});

await check("a purga seguinte reconhece o item como candidato, e não o retém como sem_origem", async () => {
  const f = falsas(filaInicial, [linha]);
  await E.purgeEliteCatalog(SHOP, { executar: true, dependencias: f.dependencias });
  const segunda = await E.purgeEliteCatalog(SHOP, { dependencias: f.dependencias });
  assert.equal(segunda.candidatos, 1, "a segunda purga tem de contar o item como candidato");
  assert.equal(segunda.retidosPorMotivo.sem_origem, undefined, "a segunda purga não pode reter como sem_origem");
});

fs.rmSync(projeto, { recursive: true, force: true });
if (falhas) {
  console.error(`\nelite-purge-origem-elite: ${falhas} verificação(ões) falharam`);
  process.exit(1);
}
console.log("\nelite-purge-origem-elite: todos os casos passaram");
