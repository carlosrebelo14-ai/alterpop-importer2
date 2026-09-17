#!/usr/bin/env node
/**
 * BRIEFING BACKEND · Tarefa 34 (Decisão 18) — formatExtractor.server.js.
 * Uso: node scripts/tests/format-extractor.test.js
 */
import assert from "node:assert/strict";
import {
  extractProductFormat,
  FORMAT_VALUES,
  APPROVED_FORMAT_VALUES,
} from "../../lib/importer/catalog/formatExtractor.server.js";

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

check("POP figure → Figure", () => {
  assert.equal(extractProductFormat({ title: "POP figure One Piece Luffy" }), "Figure");
});

check("Pocket POP Keychain → Keychain (Keychain vence Figure, mais específico)", () => {
  assert.equal(extractProductFormat({ title: "Pocket POP Keychain Batman" }), "Keychain");
});

check("Loungefly backpack → Backpack", () => {
  assert.equal(extractProductFormat({ title: "Loungefly Disney Cars Mystery Blind Box Enamel Pins" }), "Backpack");
});

check("puzzle → Puzzle", () => {
  assert.equal(extractProductFormat({ title: "Minecraft puzzle 3D 54pcs" }), "Puzzle");
});

check("plush toy → Plush", () => {
  assert.equal(extractProductFormat({ title: "Care Bears Good Luck Bear plush toy 35cm" }), "Plush");
});

check("mug → Mug", () => {
  assert.equal(extractProductFormat({ title: "Rick and Morty Retro Poster mug" }), "Mug");
});

check("sem sinal nenhum → null", () => {
  assert.equal(extractProductFormat({ title: "Form Words game" }), null);
  assert.equal(extractProductFormat({}), null);
});

// R1 (auditoria live, 17/09/2026) — plural aceite, não só singular.
check("R1 · plural 'figures' → Figure (caso real: pack Darth Vader & Luke Skywalker)", () => {
  assert.equal(
    extractProductFormat({ title: "POP pack 2 figures Star Wars Darth Vader & Luke Skywalker" }),
    "Figure"
  );
});
check("R1 · singular continua a bater (não regrediu)", () => {
  assert.equal(extractProductFormat({ title: "POP figure One Piece Luffy" }), "Figure");
});

// R2 (auditoria live, 17/09/2026) — formato implícito pela manufacturer_line, só para
// linhas confirmadas como sempre-figura, e só quando o título não dá formato nenhum.
check("R2 · WCF (Banpresto, World Collectable Figure) sem a palavra 'figure' no título → Figure (caso real: Luffy Gear 5)", () => {
  assert.equal(
    extractProductFormat({ title: "One Piece Monkey D Luffy Gear 5 WCF Special 13cm", vendor: "Banpresto" }),
    "Figure"
  );
});
check("R2 · título já dá formato explícito vence sobre a linha implícita", () => {
  assert.equal(
    extractProductFormat({ title: "One Piece Luffy WCF figure 13cm", vendor: "Banpresto" }),
    "Figure"
  );
});
check("R2 · linha Tamashii (S.H.Figuarts) sem 'figure' no título → Figure", () => {
  assert.equal(
    extractProductFormat({ title: "Dragon Ball Z Goku S.H.Figuarts 15cm", vendor: "Tamashii Nations" }),
    "Figure"
  );
});
check("R2 · NECA Ultimate → Figure, mas outra linha NECA sem sinal fica null", () => {
  assert.equal(extractProductFormat({ title: "Predator Ultimate 18cm", vendor: "NECA" }), "Figure");
  assert.equal(extractProductFormat({ title: "Alien Kenner Tribute pack", vendor: "NECA" }), null);
});
check("R2 · McFarlane DC Multiverse → Figure, mas Theatrical Edition (fora da tabela) fica null", () => {
  assert.equal(extractProductFormat({ title: "Batman DC Multiverse 18cm", vendor: "McFarlane Toys" }), "Figure");
  assert.equal(extractProductFormat({ title: "Batman Theatrical Edition 18cm", vendor: "McFarlane Toys" }), null);
});
check("R2 · fabricante fora do mapa nunca infere formato", () => {
  assert.equal(extractProductFormat({ title: "Something 13cm", vendor: "Desconhecido Ltd" }), null);
});

// R3/D2 (ADENDA 4, 17/09/2026) — o Carlos decidiu criar a categoria Doll. Substitui o
// teste anterior (que documentava o null de propósito, antes da decisão).
check("R3/D2 · 'doll' → Doll (caso real: Elsa doll, resolvido pela decisão do Carlos)", () => {
  assert.equal(extractProductFormat({ title: "Disney Frozen Tea set Elsa doll 38cm" }), "Doll");
});
check("D2 · plural 'dolls' também bate (R1 continua a aplicar-se a Doll)", () => {
  assert.equal(extractProductFormat({ title: "Barbie Fashionista assorted dolls" }), "Doll");
});
check("D2 · needle em espanhol do fornecedor ('muñeca')", () => {
  assert.equal(extractProductFormat({ title: "Barbie Fashionista muñeca surtida" }), "Doll");
});

// D2 — auditoria de idioma: todos os VALORES de formato (não as needles) são em
// inglês. Um valor fora da lista aprovada falha aqui, não só num relatório informal.
check("D2 · FORMAT_VALUES nunca tem um valor fora da lista aprovada (auditoria de idioma)", () => {
  for (const value of FORMAT_VALUES) {
    assert.ok(
      APPROVED_FORMAT_VALUES.includes(value),
      `"${value}" não está em APPROVED_FORMAT_VALUES — decisão do Carlos em falta`
    );
  }
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nformat-extractor: todos os casos passaram");
