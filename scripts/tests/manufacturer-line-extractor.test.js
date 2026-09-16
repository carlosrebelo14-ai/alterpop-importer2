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

check("Tamashii Nations — S.H.Figuarts, todas as variantes de grafia do fornecedor", () => {
  assert.equal(extractManufacturerLine({ vendor: "TAMASHII NATIONS", title: "Dandadan Momo Ver.2 S.H. Figuarts figure 14cm" }), "S.H.Figuarts");
  assert.equal(extractManufacturerLine({ vendor: "TAMASHII NATIONS", title: "Naruto Shippuden Orochimaru Seeker of Inmortality S.H.Figuarts figure 15cm" }), "S.H.Figuarts");
  assert.equal(extractManufacturerLine({ vendor: "TAMASHII NATIONS", title: "One Piece Sir Crocodile Marineford S.H. Figuarts figure 18cm" }), "S.H.Figuarts");
  assert.equal(extractManufacturerLine({ vendor: "TAMASHII NATIONS", title: "Demon Slayer Kimetsu No Yaiba Doma S.H. Figurarts figure 15,5cm" }), "S.H.Figuarts");
  assert.equal(extractManufacturerLine({ vendor: "TAMASHII NATIONS", title: "Space Sheriff Gavan SHFiguarts Gavan figure 14.5cm" }), "S.H.Figuarts");
});

check("Tamashii Nations — Figuarts Zero vence sobre S.H.Figuarts (mais específica)", () => {
  assert.equal(extractManufacturerLine({ vendor: "TAMASHII NATIONS", title: "Naruto Shippuden Figuarts Zero Startune Uzumaki The Will To Hokage figure 24cm" }), "Figuarts Zero");
});

check("Tamashii Nations — outras linhas do censo", () => {
  assert.equal(extractManufacturerLine({ vendor: "TAMASHII NATIONS", title: "Godzilla 1975 S.H.MonsterArts figure 16cm" }), "S.H.MonsterArts");
  assert.equal(extractManufacturerLine({ vendor: "TAMASHII NATIONS", title: "Mobile Suit Gundam Robot Spirits Side MS MSM 10 Zock ver. ANIME figure 16.5cm" }), "Robot Spirits");
  assert.equal(extractManufacturerLine({ vendor: "TAMASHII NATIONS", title: "Mazinger Z GX-04S Grendizer Soul of Chogokin figure" }), "Soul of Chogokin");
  assert.equal(extractManufacturerLine({ vendor: "TAMASHII NATIONS", title: "Saint Seiya Saint Cloth Myth Ex 40th Anniversary ver. Alpha Dubhe Siegfried figure 18cm" }), "Saint Cloth Myth");
  assert.equal(extractManufacturerLine({ vendor: "TAMASHII NATIONS", title: "Gundam Universe MS-06S Char's Zaku II Renewal figure 15cm" }), "Gundam Universe");
});

check("NECA — Ultimate", () => {
  assert.equal(extractManufacturerLine({ vendor: "NECA", title: "Universal Monsters Ultimate Frankenstein Monster figure 18cm" }), "Ultimate");
  assert.equal(extractManufacturerLine({ vendor: "NECA", title: "Gremlins Gizmo plush toy with sound and movement 20cm" }), null);
});

check("McFarlane Toys — DC Multiverse, Theatrical/Elite Edition, Cube Qubi", () => {
  assert.equal(extractManufacturerLine({ vendor: "MCFARLANE TOYS", title: "DC Comics Multiverse Superman figure 18cm" }), "DC Multiverse");
  assert.equal(extractManufacturerLine({ vendor: "MCFARLANE TOYS", title: "DC Comics Supergirl Deluxe Theatrical Edition Lobo figure 18cm" }), "Theatrical Edition");
  assert.equal(extractManufacturerLine({ vendor: "MCFARLANE TOYS", title: "Fallout Elite Edition Nuka Cola T-60 figure 19cm" }), "Elite Edition");
  assert.equal(extractManufacturerLine({ vendor: "MCFARLANE TOYS", title: "Harry Potter assorted Cube Qubi" }), "Cube Qubi");
});

check("Banpresto — linhas medidas nos 45 produtos ACTIVE da loja (16/09/2026)", () => {
  assert.equal(extractManufacturerLine({ vendor: "BANPRESTO", title: "One Piece Battle Record Collection Monkey D.Luffy figure 13cm" }), "Battle Record");
  assert.equal(extractManufacturerLine({ vendor: "BANPRESTO", title: "One Piece World Collectable Figure Special Monkey D. Luffy figure 12cm" }), "World Collectable Figure");
  assert.equal(extractManufacturerLine({ vendor: "BANPRESTO", title: "One Piece Monkey D Luffy Gear 5 WCF Special 13cm" }), "World Collectable Figure");
  assert.equal(extractManufacturerLine({ vendor: "BANPRESTO", title: "One Piece Log Stories Monkey D Luffy vs Local Sea figure 7cm" }), "Log Stories");
  assert.equal(extractManufacturerLine({ vendor: "BANPRESTO", title: "One Piece DXF The Grandline Series Monkey D. Luffy figure 16cm" }), "Grandline Series");
  assert.equal(extractManufacturerLine({ vendor: "BANPRESTO", title: "One Piece King of Artist Monkey D Luffy Gear 4 Boundman figure 17cm" }), "King of Artist");
  assert.equal(extractManufacturerLine({ vendor: "BANPRESTO", title: "One Piece Maximatic Monkey D Luffy ver.A figure 21cm" }), "Maximatic");
  assert.equal(extractManufacturerLine({ vendor: "BANPRESTO", title: "One Piece The Shukko Monkey D. Luffy figure 14cm" }), "The Shukko");
  assert.equal(extractManufacturerLine({ vendor: "BANPRESTO", title: "One Piece Netflix Live Action Big Fluffy Puffy Chopper figure 14cm" }), "Fluffy Puffy");
  assert.equal(extractManufacturerLine({ vendor: "BANPRESTO", title: "One Piece Dioramatic The Anime D Luffy Monkey figure 20cm" }), "Dioramatic");
});

check("Banpresto — Log Stories vence sobre World Collectable Figure quando os dois aparecem", () => {
  assert.equal(
    extractManufacturerLine({ vendor: "BANPRESTO", title: "One Piece World Collectable Figure Log Stories Monkey D. Luffy vs Kuzan 9cm" }),
    "Log Stories"
  );
});

check("Banpresto — Senkozekkei: erro de escrita do fornecedor (Senkokkei, falta \"ze\") tem needle próprio", () => {
  assert.equal(extractManufacturerLine({ vendor: "BANPRESTO", title: "One Piece Senkozekkei Monkey D. Luffy figure 15cm" }), "Senkozekkei");
  assert.equal(extractManufacturerLine({ vendor: "BANPRESTO", title: "One Piece Monkey D Luffy Gear 4 Senkokkei figure 15cm" }), "Senkozekkei");
});

check("Banpresto — \"fIchibansho\" (typo do fornecedor, sem espaço) ainda bate por ser substring puro, não regex \\b", () => {
  assert.equal(
    extractManufacturerLine({ vendor: "BANPRESTO", title: "One Piece The Future of Imagination Last Battle Monkey D Luffy fIchibansho figure 22cm" }),
    "Ichibansho"
  );
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
