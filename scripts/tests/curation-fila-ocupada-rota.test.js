#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-04, decisão 1 do arquiteto. Quando o prazo do lock da fila expira, as rotas do painel que
 * escrevem aprovação e rejeição respondem "fila ocupada, tenta de novo" (503), e não um erro genérico.
 *
 * Teste estático: lê as rotas sem comentários (semComentarios) e verifica a ordem dentro do catch.
 * O código CURATION_QUEUE_LOCK_TIMEOUT vem antes da resposta genérica (404), e a mensagem vem na
 * resposta de 503 desse ramo.
 *
 * Uso: node scripts/tests/curation-fila-ocupada-rota.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { semComentarios } from "./_sem-comentarios.js";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROTAS = [
  "app/routes/api.curation.queue.$sku.approve.jsx",
  "app/routes/api.curation.queue.$sku.reject.jsx",
];
const MENSAGEM = '"fila ocupada, tenta de novo"';
const CODIGO = 'err?.code === "CURATION_QUEUE_LOCK_TIMEOUT"';

const resultados = [];

function caso(nome, fn) {
  try {
    fn();
    resultados.push({ nome, resultado: "passa" });
    console.log(`  passa  ${nome}`);
  } catch (err) {
    resultados.push({ nome, resultado: "falha", detalhe: err.message });
    console.log(`  falha  ${nome}\n      ${String(err.message).split("\n").join("\n      ")}`);
  }
}

function verificarRota(rota) {
  const codigo = semComentarios(fs.readFileSync(path.join(RAIZ, rota), "utf8"));
  const catchDoErro = codigo.indexOf("catch (err)");
  assert.ok(catchDoErro >= 0, `${rota}: falta o catch (err)`);
  const condicao = codigo.indexOf(CODIGO, catchDoErro);
  assert.ok(condicao > catchDoErro, `${rota}: falta o ramo ${CODIGO} dentro do catch`);
  const mensagem = codigo.indexOf(MENSAGEM, condicao);
  assert.ok(mensagem > condicao, `${rota}: a mensagem ${MENSAGEM} tem de estar no ramo do prazo`);
  const resposta = codigo.slice(mensagem, codigo.indexOf(");", mensagem));
  assert.match(resposta, /status:\s*503/, `${rota}: o ramo do prazo tem de responder 503`);
  const generico = codigo.indexOf("{ status: 404 }", catchDoErro);
  assert.ok(generico > mensagem, `${rota}: a resposta genérica vem antes do ramo do prazo`);
}

console.log("curation-fila-ocupada-rota");
for (const rota of ROTAS) {
  caso(`${path.basename(rota)} responde "fila ocupada, tenta de novo" com 503 no prazo do lock`, () => verificarRota(rota));
}

const nao = resultados.filter((r) => r.resultado !== "passa").length;
if (nao) {
  console.error(`\n${nao} caso(s) não passam`);
  process.exit(1);
}
console.log("\ncuration-fila-ocupada-rota: todos os casos passaram");
