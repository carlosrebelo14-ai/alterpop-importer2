#!/usr/bin/env node
/* eslint-env node */
/**
 * Decisão 35, D7: cobertura da guarda de atividade da app nos scripts que escrevem a fila ou publicam.
 *
 * Um script é escritor se importa (estático ou dinâmico) uma função de escrita da fila ou de
 * publicação. Não há lista de scripts: o teste percorre scripts/ (.js e .mjs, recursivo) e decide.
 * Os nomes vêm de duas fontes. ESCRITAS_REMOTAS (lib/curation/curationQueue.server.js) é lida do
 * código. ESCRITAS_EXTRA são as funções que publicam ou escrevem noutros módulos. Cada nome de
 * ESCRITAS_EXTRA tem de ser exportado por lib/. Se deixar de o ser, o teste falha, e a cobertura
 * não cai em silêncio.
 *
 * Todo o escritor chama recusarSeAtividadeApp( (lib/curation/atividadeApp.js) antes de escrever.
 * Vale também em dry-run. scripts/tests/ fica de fora: são testes, não scripts de produção.
 *
 * Uso: node scripts/tests/curation-guard-coverage.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPTS = path.join(RAIZ, "scripts");
const LIB = path.join(RAIZ, "lib");
const CURATION_QUEUE = path.join(LIB, "curation", "curationQueue.server.js");
const GUARDA = "recusarSeAtividadeApp";

/** Funções de escrita que publicam ou escrevem noutros módulos (além de ESCRITAS_REMOTAS). */
const ESCRITAS_EXTRA = [
  "mutateCurationQueue",
  "saveCurationQueue",
  "revertAllPublishedInQueue",
  "revertLocalAfterShopifyReset",
  "runShopifyCatalogReset",
  "startShopifyCatalogResetInBackground",
  "runApprovedShopifySync",
  "startApprovedShopifySyncInBackground",
  "runStreamImport",
  "runImport",
  "ProductImporter",
  "purgeEliteCatalog",
  "executeReprice",
  "recordPriceWrite",
  "publishCatalogProductToShopify",
];

/** @param {string} dir @param {(caminho: string) => boolean} aceita */
function listar(dir, aceita) {
  const saida = [];
  for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
    const caminho = path.join(dir, entrada.name);
    if (entrada.isDirectory()) saida.push(...listar(caminho, aceita));
    else if (aceita(caminho)) saida.push(caminho);
  }
  return saida.sort();
}

function escritasRemotas() {
  const texto = fs.readFileSync(CURATION_QUEUE, "utf8");
  const bloco = texto.match(/const ESCRITAS_REMOTAS = \{([\s\S]*?)\n\};/);
  if (!bloco) throw new Error("ESCRITAS_REMOTAS não encontrado em curationQueue.server.js");
  return [...bloco[1].matchAll(/^\s*(\w+),?\s*$/gm)].map((m) => m[1]);
}

/** Nomes exportados por qualquer ficheiro de lib/ (declarações e listas export { ... }). */
function nomesExportados() {
  const nomes = new Set();
  const reExport = /export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)|export\s*\{([^}]*)\}/g;
  for (const ficheiro of listar(LIB, (p) => /\.jsx?$/.test(p))) {
    for (const m of fs.readFileSync(ficheiro, "utf8").matchAll(reExport)) {
      if (m[1]) {
        nomes.add(m[1]);
        continue;
      }
      for (const parte of m[2].split(",")) {
        const partes = parte.trim().split(/\s+as\s+/);
        if (partes[0]) nomes.add(partes[partes.length - 1]);
      }
    }
  }
  return nomes;
}

/** @param {string} lista conteúdo de { ... } de um import */
function nomesDe(lista) {
  return lista
    .split(",")
    .map((parte) => parte.trim().split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
}

/** Nomes importados e identificadores de namespace (import * as X, const X = await import(...)). */
function importacoes(texto) {
  const nomes = new Set();
  const namespaces = new Set();
  for (const m of texto.matchAll(/^\s*import\s+([^;'"]*?)\s+from\s+["'][^"']+["']/gm)) {
    const clausula = m[1];
    const chaves = clausula.match(/\{([^}]*)\}/);
    if (chaves) for (const nome of nomesDe(chaves[1])) nomes.add(nome);
    const ns = clausula.match(/\*\s+as\s+(\w+)/);
    if (ns) namespaces.add(ns[1]);
  }
  for (const m of texto.matchAll(/\{([^}]*)\}\s*=\s*await\s+import\(\s*["'][^"']+["']\s*\)/g)) {
    for (const nome of nomesDe(m[1])) nomes.add(nome);
  }
  for (const m of texto.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*await\s+import\(/g)) namespaces.add(m[1]);
  return { nomes, namespaces };
}

const escritasDaFila = escritasRemotas();
const escritas = new Set([...escritasDaFila, ...ESCRITAS_EXTRA]);
const exportados = nomesExportados();

const escritores = [];
const ficheiros = listar(SCRIPTS, (p) => /\.(js|mjs)$/.test(p)).filter(
  (p) => !path.relative(SCRIPTS, p).startsWith(`tests${path.sep}`)
);
for (const ficheiro of ficheiros) {
  const texto = fs.readFileSync(ficheiro, "utf8");
  const { nomes, namespaces } = importacoes(texto);
  const usados = new Set([...nomes].filter((n) => escritas.has(n)));
  for (const ns of namespaces) {
    for (const nome of escritas) {
      if (new RegExp(`\\b${ns}\\s*\\.\\s*${nome}\\b`).test(texto)) usados.add(`${ns}.${nome}`);
    }
  }
  if (usados.size === 0) continue;
  escritores.push({
    ficheiro: path.relative(RAIZ, ficheiro),
    usados: [...usados].sort(),
    guarda: new RegExp(`\\b${GUARDA}\\s*\\(`).test(texto),
  });
}

let falhas = 0;
function check(nome, fn) {
  try {
    fn();
    console.log(`  ok  ${nome}`);
  } catch (err) {
    falhas += 1;
    console.error(`FAIL  ${nome}\n      ${err.message}`);
  }
}

check(`ESCRITAS_REMOTAS lida do código (${escritasDaFila.length} funções)`, () => {
  assert.ok(escritasDaFila.length >= 10, "a leitura de ESCRITAS_REMOTAS tem de encontrar as escritas da fila");
});

check("os nomes de ESCRITAS_EXTRA existem como exportação de lib/", () => {
  const inexistentes = ESCRITAS_EXTRA.filter((n) => !exportados.has(n));
  assert.deepEqual(inexistentes, [], "nomes de referência sem exportação em lib/ (renomeados ou removidos)");
});

check("a varredura encontra os escritores conhecidos (sanidade)", () => {
  const conhecidos = ["scripts/catalog/run-approved-sync.js", "scripts/catalog/curation-mark-deleted.js"];
  for (const c of conhecidos) {
    assert.ok(escritores.some((e) => e.ficheiro === c), `${c} tem de ser detetado como escritor`);
  }
});

check(`todos os escritores chamam ${GUARDA}( antes de escrever (${escritores.length} escritores)`, () => {
  const sem = escritores.filter((e) => !e.guarda).map((e) => `${e.ficheiro} (${e.usados.join(", ")})`);
  assert.deepEqual(sem, [], `sem a guarda de atividade:\n        ${sem.join("\n        ")}`);
});

if (falhas) {
  console.error(`\ncuration-guard-coverage: ${falhas} verificação(ões) falharam`);
  process.exit(1);
}
console.log("\ncuration-guard-coverage: todos os escritores têm a guarda");
