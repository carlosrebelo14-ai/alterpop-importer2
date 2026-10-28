#!/usr/bin/env node
/**
 * Handles canónicos (decisão do arquiteto, 28/10/2026). Se o nome principal ou um alias gerar um
 * handle que já existe na loja, esse handle ganha. Nenhum nome do vocabulário pode gerar um handle
 * novo para um personagem que já tem metaobject. Uso: node scripts/tests/character-handles.test.js
 */
import assert from "node:assert/strict";
import { CHARACTER_VOCABULARY, CHARACTER_ALIASES, HANDLES_EXISTENTES } from "../../lib/importer/catalog/characterVocabulary.js";
import { handleCanonico, toHandle } from "../../lib/importer/catalog/characterResolver.server.js";

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

const nomes = CHARACTER_VOCABULARY.flatMap((e) => e.nomes);

check("nenhum nome do vocabulário gera handle novo para um personagem que já tem metaobject", () => {
  for (const nome of nomes) {
    const candidatos = [nome, ...(CHARACTER_ALIASES[nome] || [])].map(toHandle);
    const existente = candidatos.find((h) => HANDLES_EXISTENTES.includes(h));
    if (existente) assert.equal(handleCanonico(nome), existente, `${nome} devia ligar a ${existente}`);
  }
});

check("cada handle existente (exceto qa-dead-ref) tem um nome do vocabulário que o produz", () => {
  const produzidos = new Set(nomes.map(handleCanonico));
  const sem = HANDLES_EXISTENTES.filter((h) => h !== "qa-dead-ref" && !produzidos.has(h));
  assert.deepEqual(sem, [], `handles existentes sem nome no vocabulário: ${sem.join(", ")}`);
});

check("Monkey D. Luffy fica em luffy (handle existente da loja)", () => {
  assert.equal(handleCanonico("Monkey D. Luffy"), "luffy");
});

check("nome sem handle existente usa o slug do nome principal", () => {
  assert.equal(handleCanonico("Roronoa Zoro"), "roronoa-zoro");
  assert.equal(handleCanonico("Eren Jaeger"), "eren-jaeger");
});

console.log(failures ? `\nFALHOU — ${failures} falha(s)` : "\nOK — 0 falha(s)");
process.exitCode = failures ? 1 : 0;
