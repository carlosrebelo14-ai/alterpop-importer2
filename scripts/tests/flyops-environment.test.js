#!/usr/bin/env node
/**
 * fly-ops — environment por comando (decisão do Carlos, 28/10/2026). Comandos de leitura usam
 * production-read (sem required reviewers); comandos com escrita usam production (aprovação).
 * Falha se um comando com escrita estiver mapeado para production-read.
 * Uso: node scripts/tests/flyops-environment.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = fs.readFileSync(path.join(ROOT, ".github/workflows/fly-ops.yml"), "utf8");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

function classificar(texto) {
  const opcoes = [...texto.matchAll(/options:\s*\n((?:\s+- [\w-]+\n)+)/g)][0]?.[1]
    .split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
  const linha = texto.match(/^\s+environment: \$\{\{ contains\(fromJSON\('(\[[^']*\])'\), inputs\.comando\) && 'production-read' \|\| 'production' \}\}$/m);
  const leitura = linha ? JSON.parse(linha[1]) : null;
  const escrita = (opcoes || []).filter((c) => c.endsWith("-execute") || c === "cycle-apply-once");
  return { opcoes: opcoes || [], leitura, escrita, linhaEncontrada: Boolean(linha) };
}

const { opcoes, leitura, escrita, linhaEncontrada } = classificar(src);
const linhaEnv = linhaEncontrada ? true : null;

check("a lista de comandos foi encontrada", () => {
  assert.ok(opcoes && opcoes.length > 0);
});

check("a linha de environment usa production-read para leitura e production como defeito", () => {
  assert.ok(linhaEnv, "linha de environment não bate com o padrão esperado");
});

check("mutação: se cycle-apply-once for para production-read, a verificação falha", () => {
  const mutado = src.replace(/\["b1-dry","b2-dry","census-c","verify-base","candidates-dry","tags-dry"\]/, '["b1-dry","b2-dry","census-c","verify-base","candidates-dry","tags-dry","cycle-apply-once"]');
  assert.notEqual(mutado, src, "mutação não aplicada");
  const r = classificar(mutado);
  assert.ok(r.escrita.some((c) => r.leitura.includes(c)), "a verificação deveria apanhar a escrita em leitura");
});

check("leitura é exatamente b1-dry, b2-dry, census-c, verify-base, candidates-dry, tags-dry", () => {
  assert.deepEqual([...leitura].sort(), ["b1-dry", "b2-dry", "candidates-dry", "census-c", "tags-dry", "verify-base"].sort());
});

check("nenhum comando com escrita está mapeado para production-read", () => {
  const mal = escrita.filter((c) => leitura.includes(c));
  assert.deepEqual(mal, [], `comandos com escrita em production-read: ${mal.join(", ")}`);
});

check("todo comando da lista tem environment: leitura ou escrita (fica em production)", () => {
  const sem = opcoes.filter((c) => !leitura.includes(c) && !escrita.includes(c));
  assert.deepEqual(sem, []);
});

check("escrita: b1-execute, b2-execute, cycle-apply-once", () => {
  assert.deepEqual([...escrita].sort(), ["b1-execute", "b2-execute", "cycle-apply-once"]);
});

console.log(failures ? `\nFALHOU — ${failures} falha(s)` : "\nOK — 0 falha(s)");
process.exitCode = failures ? 1 : 0;
