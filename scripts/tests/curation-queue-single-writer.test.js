#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-04, Decisão 35 (D1, D3, D7). Teste estático de escritor único da fila de curadoria.
 *
 * O processo principal é o único escritor de curation-queue.json. Este teste falha se:
 *   1. algum ficheiro fora da lista permitida referir saveCurationQueue (chamada ou import);
 *   2. algum ficheiro fora de lib/curation/curationQueue.server.js escrever ou mover o ficheiro da fila;
 *   3. alguma escrita exportada de curationQueue.server.js não estiver registada em ESCRITAS_REMOTAS
 *      (ou não passar por escrever/pedir), ou o registo apontar para nomes que não existem.
 * Os testes (scripts/tests/) podem usar saveCurationQueue para preparar uma fila temporária: é isso
 * que a lista permitida cobre. Nenhum caminho de produção o pode fazer.
 *
 * Uso: node scripts/tests/curation-queue-single-writer.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FICHEIRO_DA_FILA = "lib/curation/curationQueue.server.js";
const PASTAS = ["lib", "app", "scripts", "server"];
const EXTENSOES = /\.(js|jsx|mjs|cjs|ts|tsx)$/;
const IGNORADAS = new Set(["node_modules", "build", "dist", ".git"]);
/** Só os testes podem preparar a fila com saveCurationQueue. Produção não entra aqui. */
const PERMITIDOS_SAVE = (ficheiro) => ficheiro === FICHEIRO_DA_FILA || ficheiro.startsWith("scripts/tests/");

function listarFicheiros(dir, saida = []) {
  if (!fs.existsSync(dir)) return saida;
  for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORADAS.has(entrada.name)) continue;
    const caminho = path.join(dir, entrada.name);
    if (entrada.isDirectory()) listarFicheiros(caminho, saida);
    else if (EXTENSOES.test(entrada.name)) saida.push(path.relative(RAIZ, caminho).split(path.sep).join("/"));
  }
  return saida;
}

const ficheiros = PASTAS.flatMap((pasta) => listarFicheiros(path.join(RAIZ, pasta)));
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), "utf8");

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

check("saveCurationQueue só é referido em produção pelo próprio módulo da fila", () => {
  const infratores = ficheiros.filter((f) => !PERMITIDOS_SAVE(f) && /\bsaveCurationQueue\b/.test(ler(f)));
  assert.deepEqual(infratores, [], `ficheiros fora do escritor único que referem saveCurationQueue: ${infratores.join(", ")}`);
});

check("nenhum ficheiro de produção fora da fila escreve o ficheiro curation-queue.json", () => {
  const infratores = ficheiros.filter((f) => {
    if (f === FICHEIRO_DA_FILA || f.startsWith("scripts/tests/")) return false;
    const src = ler(f);
    return /curation-queue\.json/.test(src) && /\b(writeFile|writeFileSync|rename|renameSync|appendFile|copyFile)\b/.test(src);
  });
  assert.deepEqual(infratores, [], `ficheiros que escrevem a fila fora do escritor único: ${infratores.join(", ")}`);
});

check("o módulo da fila tem o escritor físico e o lock (não é um teste vazio)", () => {
  const src = ler(FICHEIRO_DA_FILA);
  assert.match(src, /export async function saveCurationQueue/);
  assert.match(src, /async function escreverFila\(/);
  assert.match(src, /function withCurationQueueLock\(/);
  assert.match(src, /export async function mutateCurationQueue\(/);
});

check("cada escrita exportada de curationQueue.server.js é registada em ESCRITAS_REMOTAS", () => {
  const src = ler(FICHEIRO_DA_FILA);
  const bloco = src.match(/const ESCRITAS_REMOTAS = \{([\s\S]*?)\};/);
  assert.ok(bloco, "ESCRITAS_REMOTAS não encontrado");
  const registadas = [...bloco[1].matchAll(/^\s*(\w+),?\s*$/gm)].map((m) => m[1]);
  assert.ok(registadas.length >= 10, `registo com poucas operações: ${registadas.length}`);

  // Escritas exportadas que tocam o lock de escrita: têm de estar registadas.
  const exportadas = [...src.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]);
  const escritoras = exportadas.filter((nome) => {
    const corpo = src.slice(src.indexOf(`export async function ${nome}(`));
    const fim = corpo.indexOf("\n}\n");
    return /withCurationQueueLock\(|mutateCurationQueue\(|flushCurationQueueItems|saveCurationQueue\(/.test(corpo.slice(0, fim < 0 ? 400 : fim + 2));
  });
  assert.ok(escritoras.length >= 10, `poucas escritas detetadas (${escritoras.length}): o teste ficaria vácuo`);
  const semRegisto = escritoras.filter((nome) => !registadas.includes(nome) && !["saveCurationQueue", "mutateCurationQueue"].includes(nome));
  assert.deepEqual(semRegisto, [], `escritas exportadas fora de ESCRITAS_REMOTAS: ${semRegisto.join(", ")}`);

  for (const nome of registadas) {
    assert.ok(new RegExp(`(escrever|pedir)\\(\\s*"${nome}"`).test(src), `${nome} está em ESCRITAS_REMOTAS mas não passa por escrever/pedir`);
    assert.ok(new RegExp(`export (async )?function ${nome}\\(`).test(src), `${nome} está em ESCRITAS_REMOTAS mas não é exportado`);
  }
});

if (falhas) {
  console.error(`\n${falhas} falha(s)`);
  process.exit(1);
}
console.log(`\ncuration-queue-single-writer: ${ficheiros.length} ficheiros verificados, todos os casos passaram`);
