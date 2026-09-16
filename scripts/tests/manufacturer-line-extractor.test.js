#!/usr/bin/env node
/**
 * B6 — manufacturerLineExtractor.server.js.
 * Uso: node scripts/tests/manufacturer-line-extractor.test.js
 */
import assert from "node:assert/strict";
import { extractManufacturerLine } from "../../lib/importer/catalog/manufacturerLineExtractor.server.js";

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

check("Ichibansho — caso genérico", () => {
  assert.equal(
    extractManufacturerLine({ vendor: "BANPRESTO", title: "Dragon Ball GT Super Saiyan 4 Son Goku Ichibansho figure 25cm" }),
    "Ichibansho"
  );
});

check("linha temática dentro do Ichiban Kuji vence sobre o guarda-chuva Ichibansho", () => {
  assert.equal(
    extractManufacturerLine({ vendor: "Banpresto", title: "Dragon Ball Mystical Adventure Demon Piccolo Daimaoh Ichibansho figure 26cm" }),
    "Mystical Adventure"
  );
  assert.equal(
    extractManufacturerLine({ vendor: "Banpresto", title: "One Piece Duel Memories Charlotte Katakuri Ichibansho figure 10cm" }),
    "Duel Memories"
  );
});

check("outras linhas reais do censo (16/09/2026)", () => {
  assert.equal(extractManufacturerLine({ vendor: "Banpresto", title: "Dragon Ball Super Grandista Son Goku V figure 25cm" }), "Grandista");
  assert.equal(extractManufacturerLine({ vendor: "Banpresto", title: "Dragon Ball Z Solid Edge Works Vegito figure 20cm" }), "Solid Edge Works");
  assert.equal(extractManufacturerLine({ vendor: "Banpresto", title: "Dragon Ball GT Match Makers Super Saiyan 4 Son Goku figure 16cm" }), "Match Makers");
  assert.equal(extractManufacturerLine({ vendor: "Banpresto", title: "Naruto 72 Series Vibration Stars Uzumaki figure 15cm" }), "Vibration Stars");
  assert.equal(extractManufacturerLine({ vendor: "Banpresto", title: "To LOVEru Darkness Konjiki No Yami Glitter & Glamorous figure 22cm" }), "Glitter & Glamorous");
  assert.equal(extractManufacturerLine({ vendor: "Banpresto", title: "My Dress-Up Darling Glitter Glamours Marin Kitagawa figure 25cm" }), "Glitter & Glamorous");
  assert.equal(extractManufacturerLine({ vendor: "Banpresto", title: "That Time I Got Reincarnated as a Slime Espresto Threefold Union Rimuru Tempest figure 22cm" }), "Espresto");
  assert.equal(extractManufacturerLine({ vendor: "Banpresto", title: "Frieren Beyond Journeys End Big Sofvimates Ringlets figure 13cm" }), "Sofvimates");
});

check("sem linha reconhecida no título — null, não inventa", () => {
  assert.equal(extractManufacturerLine({ vendor: "Banpresto", title: "One Piece Monkey D Luffy DXF figure 17cm" }), null);
});

check("fabricante fora do mapa fica SEM LINHA, nunca herda regra de outro", () => {
  assert.equal(extractManufacturerLine({ vendor: "Funko", title: "Ichibansho Pop Figure" }), null);
  assert.equal(extractManufacturerLine({ vendor: "", title: "Grandista" }), null);
  assert.equal(extractManufacturerLine({ vendor: null, title: "Grandista" }), null);
});

check("insensível a caixa/acentos no vendor (o feed escreve em maiúsculas)", () => {
  assert.equal(extractManufacturerLine({ vendor: "banpresto", title: "One Piece Shanks Grandista figure 22cm" }), "Grandista");
});

check("título vazio/ausente não rebenta", () => {
  assert.equal(extractManufacturerLine({ vendor: "Banpresto", title: "" }), null);
  assert.equal(extractManufacturerLine({ vendor: "Banpresto" }), null);
  assert.equal(extractManufacturerLine({}), null);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nmanufacturer-line-extractor: todos os casos passaram");
