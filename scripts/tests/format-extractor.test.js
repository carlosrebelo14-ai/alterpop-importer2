#!/usr/bin/env node
/**
 * C3 (briefing "catálogo limpo", 29/09/2026) — formatExtractor.server.js, vocabulário
 * novo de alterpop.format. Casos da secção 6 do briefing + títulos reais do live (os 8
 * Lord of the Rings ERIK sem formato na auditoria de 27/09).
 * Uso: node scripts/tests/format-extractor.test.js
 */
import assert from "node:assert/strict";
import {
  extractProductFormat,
  FORMAT_VOCABULARY,
  FORMAT_TITLE_KEYWORDS,
  FORMAT_BY_LINE,
  FORMAT_BY_VENDOR,
  largestSizeCm,
} from "../../lib/importer/catalog/formatExtractor.server.js";
import { checkMissingFormat } from "../../lib/importer/curation/prePublishChecks.server.js";

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

const fmt = (title, vendor = null) => extractProductFormat({ title, vendor });

// ── vocabulário ──

check("vocabulário — os 11 valores do briefing, sem Figure", () => {
  assert.deepEqual([...FORMAT_VOCABULARY], [
    "Vinyl Figure", "Prize Figure", "Statue", "Action Figure", "Mini Figure", "Model Kit",
    "Plush", "Doll", "Puzzle", "Keychain", "Home & Gifts",
  ]);
  assert.equal(FORMAT_VOCABULARY.includes("Figure"), false);
});

check("vocabulário — todas as tabelas só produzem valores do vocabulário", () => {
  const produced = [
    ...FORMAT_TITLE_KEYWORDS.map((r) => r.format),
    ...FORMAT_BY_LINE.map((r) => r.format),
    ...Object.values(FORMAT_BY_VENDOR),
  ];
  for (const v of produced) assert.ok(FORMAT_VOCABULARY.includes(v), `"${v}" fora do vocabulário`);
});

// ── casos do briefing (secção 6) ──

check("briefing — Funko com \"Pop!\" no título → Vinyl Figure", () => {
  assert.equal(fmt("Pop! One Piece Monkey D Luffy", "FUNKO"), "Vinyl Figure");
  assert.equal(fmt("POP figure Star Wars Luke Skywalker", "FUNKO"), "Vinyl Figure");
});

check("briefing — Funko porta-chaves → Keychain (regra 1 antes da linha Pop!)", () => {
  assert.equal(fmt("Pocket POP Keychain Batman", "FUNKO"), "Keychain");
});

check("briefing — Banpresto → Prize Figure", () => {
  assert.equal(fmt("One Piece Monkey D Luffy Gear 5 WCF Special 13cm", "BANPRESTO"), "Prize Figure");
});

check("briefing — ERIK candeeiro → Home & Gifts (caso real LOTR)", () => {
  assert.equal(fmt("The Lord of the Rings Earendil lamp", "ERIK"), "Home & Gifts");
  assert.equal(fmt("The Lord of the Rings One Ring lamp", "ERIK"), "Home & Gifts");
});

// ── decisão de 29/09: os 4 casos do dry-run do format-backfill ──

check("dry-run 29/09 — Hasbro Armorer 10cm → Action Figure (omissão Hasbro)", () => {
  assert.equal(fmt("Star Wars Carbonized Collection The Armorer figure 10cm Vintage", "HASBRO"), "Action Figure");
});

check("dry-run 29/09 — Jakks Tsum Tsum → Mini Figure (palavra-chave)", () => {
  assert.equal(fmt("Disney Stitch Tsum Tsum Story Moment figure", "JAKKS PACIFIC"), "Mini Figure");
});

check("dry-run 29/09 — Jakks Mario Kart 6cm → Mini Figure (tamanho ≤ 7 cm, antes da omissão)", () => {
  assert.equal(fmt("Mario Kart Spinout Luigi Kart figure 6cm", "JAKKS PACIFIC"), "Mini Figure");
});

check("dry-run 29/09 — Jakks Mario 13cm → Action Figure (omissão Jakks Pacific)", () => {
  assert.equal(fmt("Super Mario Bros Mario figure 13cm", "JAKKS PACIFIC"), "Action Figure");
});

check("tamanho — 7 cm ainda é Mini Figure; 8 cm já não; sem \"figure\" não conta", () => {
  assert.equal(fmt("One Piece Log Stories Luffy vs Local Sea figure 7cm", "BANPRESTO"), "Mini Figure");
  assert.equal(fmt("One Piece Luffy Going Merry Log Stories figure 8cm", "BANPRESTO"), "Prize Figure");
  assert.equal(fmt("Sonic plush toy 6cm", "JAKKS PACIFIC"), "Plush");
  assert.equal(fmt("Harry Potter keyring 5cm", "STAR ACE"), null);
});

check("tamanho — linha do fabricante vence o tamanho (Funko Pop! pequeno continua Vinyl Figure)", () => {
  assert.equal(fmt("Pop! Mini Luke Skywalker figure 5cm", "FUNKO"), "Vinyl Figure");
});

check("tamanho — leitura: maior valor, decimais e intervalos", () => {
  assert.equal(largestSizeCm("figure 13.5cm"), 13.5);
  assert.equal(largestSizeCm("figure 12/16cm"), 16);
  assert.equal(largestSizeCm("figure 6 cm"), 6);
  assert.equal(largestSizeCm("sem tamanho"), null);
  // Dois tamanhos em cm: conta o maior — uma figura de 20 cm com base de 5 cm não é Mini.
  assert.equal(largestSizeCm("figure 5cm base, 20cm total"), 20);
  assert.equal(fmt("Dragon Ball Goku figure 5cm base 20cm", "JAKKS PACIFIC"), "Action Figure");
});

check("briefing — título sem pista e vendor sem omissão → vazio e MISSING_FORMAT", () => {
  assert.equal(fmt("Gandalf en Moria 18cm", "ERIK"), null);
  assert.equal(checkMissingFormat({ resolvedFormat: fmt("Gandalf en Moria 18cm", "ERIK") })?.code, "MISSING_FORMAT");
});

// ── regra 1: palavra explícita ──

check("regra 1 — os restantes LOTR ERIK: calendário, suportes de livros, porta-chaves de parede", () => {
  assert.equal(fmt("The Lord of the Rings 3D Nazgul perpetual calendar", "ERIK"), "Home & Gifts");
  assert.equal(fmt("The Lord of the Rings Argonath bookends", "ERIK"), "Home & Gifts");
  assert.equal(fmt("The Lord of the Rings Moria gate key hangers", "ERIK"), "Home & Gifts");
});

check("regra 1 — plush, puzzle, statue, bust, diorama, model kit, caneca", () => {
  assert.equal(fmt("Care Bears Good Luck Bear plush toy 35cm"), "Plush");
  assert.equal(fmt("Minecraft puzzle 3D 54pcs", "RAVENSBURGER"), "Puzzle");
  assert.equal(fmt("Batman 1989 statue 30cm", "STAR ACE"), "Statue");
  assert.equal(fmt("Robocop bust 1/2"), "Statue");
  assert.equal(fmt("Marvel Gallery diorama Spider-Man"), "Statue");
  assert.equal(fmt("Gundam RX-78-2 model kit 1/144", "BANDAI HOBBY"), "Model Kit");
  assert.equal(fmt("Rick and Morty Retro Poster mug"), "Home & Gifts");
});

check("regra 1 — espanhol do feed e plural", () => {
  assert.equal(fmt("Barbie Fashionista muñeca surtida"), "Doll");
  assert.equal(fmt("Barbie Fashionista assorted dolls"), "Doll");
  assert.equal(fmt("Harry Potter llavero Hedwig"), "Keychain");
});

check("regra 1 — palavra inteira, não substring (\"Ghostbusters\" não é \"bust\")", () => {
  assert.equal(fmt("Ghostbusters Slimer 15cm"), null);
});

check("regra 1 — action figure explícita", () => {
  assert.equal(fmt("Star Wars Black Series Boba Fett action figure 15cm", "HASBRO"), "Action Figure");
});

// ── regra 2: linha do fabricante ──

check("regra 2 — Ichibansho → Prize Figure, com qualquer vendor", () => {
  assert.equal(fmt("Dragon Ball Vegeta Ichibansho figure 17cm", "BANDAI SPIRITS"), "Prize Figure");
});

check("regra 2 — Gallery → Statue só na Diamond Select", () => {
  assert.equal(fmt("Marvel Gallery Venom 25cm", "DIAMOND SELECT"), "Statue");
  // Vendor sem omissão (Star Ace) — Hasbro passou a ter omissão a 29/09.
  assert.equal(fmt("Marvel Gallery Venom 25cm", "STAR ACE"), null);
});

check("regra 2 — \"pop\" fora da Funko não é Vinyl Figure (\"Pop Culture\")", () => {
  assert.equal(fmt("Pop Culture tote", "STAR ACE"), null);
});

// ── regra 3: omissão por vendor ──

check("regra 3 — omissões do briefing: Funko, Banpresto, Bandai Hobby, Minix, Plastoy", () => {
  assert.equal(fmt("Star Wars Luke Skywalker 9cm", "FUNKO"), "Vinyl Figure");
  assert.equal(fmt("Goku 17cm", "BANPRESTO"), "Prize Figure");
  assert.equal(fmt("RX-78-2 1/144", "BANDAI HOBBY"), "Model Kit");
  assert.equal(fmt("Harry Potter 12cm", "MINIX"), "Mini Figure");
  assert.equal(fmt("Tintin 8cm", "PLASTOY"), "Mini Figure");
});

check("regra 3 — vendor pela chave do feed (nome do mapa ou maiúsculas dão o mesmo)", () => {
  assert.equal(fmt("Luke 9cm", "Funko"), "Vinyl Figure");
  assert.equal(fmt("Luke 9cm", " funko "), "Vinyl Figure");
});

check("regra 3 — produto atípico da marca não leva a omissão (mochila Funko fica vazia)", () => {
  assert.equal(fmt("Loungefly Disney Cars backpack", "FUNKO"), null);
  assert.equal(fmt("Loungefly Disney Cars Mystery Blind Box Enamel Pins", "FUNKO"), null);
});

// ── regra 4 ──

check("regra 4 — sem título e sem vendor → null", () => {
  assert.equal(extractProductFormat({}), null);
  assert.equal(fmt("Form Words game"), null);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nformat-extractor: todos os casos passaram");
