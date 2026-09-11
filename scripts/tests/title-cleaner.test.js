#!/usr/bin/env node
/**
 * BRIEFING BACKEND · Tarefa 10 — titleCleaner.server.js.
 * Uso: node scripts/tests/title-cleaner.test.js
 */
import assert from "node:assert/strict";
import { cleanProductTitle } from "../../lib/importer/catalog/titleCleaner.server.js";

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

check("remove prefixo de formato conhecido (Tarefa 32/Decisão 17: só Assorted/Latino)", () => {
  assert.equal(
    cleanProductTitle({ title: "Assorted Darth Vader", resolvedFranchise: null }),
    "Darth Vader"
  );
  // "POP figure" saiu da lista de propósito — fica intacto.
  assert.equal(
    cleanProductTitle({ title: "POP figure Darth Vader", resolvedFranchise: null }),
    "POP figure Darth Vader"
  );
});

check("remove preço/moeda embutido", () => {
  assert.equal(
    cleanProductTitle({ title: "Star Wars Darth Vader figure 12,99€", resolvedFranchise: "Star Wars" }),
    "Star Wars Darth Vader figure"
  );
  assert.equal(
    cleanProductTitle({ title: "Batman mug $19.99 clearance", resolvedFranchise: "Batman" }),
    "Batman mug clearance"
  );
});

check("colapsa franquia repetida, mantém a 1.ª ocorrência", () => {
  assert.equal(
    cleanProductTitle({ title: "Star Wars Grogu Star Wars figure", resolvedFranchise: "Star Wars" }),
    "Star Wars Grogu figure"
  );
});

check("sem franquia resolvida: não mexe em repetições", () => {
  assert.equal(
    cleanProductTitle({ title: "Funko Funko Pop assorted", resolvedFranchise: null }),
    "Funko Funko Pop assorted"
  );
});

check("normaliza espaços e pontuação órfã nas pontas", () => {
  assert.equal(
    cleanProductTitle({ title: "  - Frozen   Elsa doll -  ", resolvedFranchise: "Frozen" }),
    "Frozen Elsa doll"
  );
});

check("título sem alterações fica igual (idempotente)", () => {
  const t = "Harry Potter Hedwig plush 25cm";
  assert.equal(cleanProductTitle({ title: t, resolvedFranchise: "Harry Potter" }), t);
});

check("título vazio não rebenta", () => {
  assert.equal(cleanProductTitle({ title: "", resolvedFranchise: null }), "");
  assert.equal(cleanProductTitle({}), "");
});

// ── Decisão 8 — portão dirigido: 5 casos obrigatórios (títulos reais da loja) ──────

check("Decisão 8 · caso 1 — prefixo de fornecedor (Latino)", () => {
  assert.equal(
    cleanProductTitle({
      title: "Latino Pokemon Mega-Charizard X Ultra Premium collectible cards case",
      resolvedFranchise: "Pokémon",
    }),
    "Pokemon Mega-Charizard X Ultra Premium collectible cards case"
  );
});

check("Decisão 8 · caso 2 — marca contraditória com a ref", () => {
  assert.equal(
    cleanProductTitle({
      title: "Transformers Star Wars The Mandalorian N-1 Starfighter figure 19cm",
      resolvedFranchise: "Star Wars",
      resolvedLine: "The Mandalorian",
    }),
    "Star Wars The Mandalorian N-1 Starfighter figure 19cm"
  );
});

check("Decisão 8 · caso 3 — franquia repetida (segmento ' - X' redundante)", () => {
  assert.equal(
    cleanProductTitle({
      title: "Star Wars The Mandalorian & Grogu - The Mandalorian & Grogu Deluxe figure 9,5cm",
      resolvedFranchise: "Star Wars",
      resolvedLine: "The Mandalorian",
    }),
    "Star Wars The Mandalorian & Grogu Deluxe figure 9,5cm"
  );
});

check("Decisão 8 · caso 4 — preço e unidade", () => {
  assert.equal(
    cleanProductTitle({ title: "Batman offer pack 3.50€ x unit", resolvedFranchise: "Batman" }),
    "Batman offer pack"
  );
});

check("Decisão 8 · caso 5 — repetição interna (alias bare 'Mandalorian')", () => {
  // Tarefa 32/Decisão 17: "POP figure" saiu de FORMAT_PREFIXES, fica no título — o
  // caso continua a "mudar" (é isso que o portão exige), só que agora só via
  // alias-repetido, não mais via prefixo-formato.
  assert.equal(
    cleanProductTitle({
      title: "POP figure Rides Deluxe Star Wars Mandalorian 9 the Mandalorian in N-1 Starfighter",
      resolvedFranchise: "Star Wars",
      resolvedLine: "The Mandalorian",
    }),
    "POP figure Rides Deluxe Star Wars Mandalorian 9 in N-1 Starfighter"
  );
});

// ── Tarefa 20 — aperto do dash-repetido (achado real da amostra de 2000, Tarefa 10b) ──

check("Tarefa 20 · dash-repetido: overlap de 1 palavra colapsa quando É a franquia (Gundam)", () => {
  assert.equal(
    cleanProductTitle({
      title: "Mobile Suit Gundam - Gundam Ashtaron HG 1/144 model kit",
      resolvedFranchise: "Gundam",
    }),
    "Mobile Suit Gundam Ashtaron HG 1/144 model kit"
  );
});

check("Tarefa 20 · dash-repetido: overlap de 1 palavra genérica NÃO colapsa (falso positivo real: 'Racing')", () => {
  const t = "Carrera GO!!! Ferrari Power Racing - Racing circuit";
  assert.equal(cleanProductTitle({ title: t, resolvedFranchise: null }), t);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\ntitle-cleaner: todos os casos passaram");
