#!/usr/bin/env node
/**
 * Fase 3 — franchiseResolver: casos de precedência e validação da spec
 * (docs/normalizacao-franquias.md §"Critérios de validação" e §"Precedência").
 *
 * Uso: node scripts/tests/franchise-resolver.test.js
 */
import assert from "node:assert/strict";
import {
  resolveFranchise,
  stripFormatPrefix,
  checkPrecedenceInvariants,
  checkRefIndexCollisions,
  checkLineInvariants,
} from "../../lib/importer/catalog/franchiseResolver.server.js";
import { FRANCHISE_UNIVERSES } from "../../lib/importer/catalog/franchiseUniverses.js";
import { FRANCHISE_LINES } from "../../lib/importer/catalog/franchiseLines.js";
import { FRANCHISE_CONDITIONS, assertConditionsNFC } from "../../lib/importer/catalog/franchiseConditions.js";

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
const r = (product) => resolveFranchise(product);

// ── config da tabela ────────────────────────────────────────────────────────────
check("tabela: 40 universos (ENTREGA 2: -Mandalorian -HelloKitty; Decisão 7: +KPop Demon Hunters), active === baseline ≥ 10", () => {
  assert.equal(FRANCHISE_UNIVERSES.length, 40);
  for (const u of FRANCHISE_UNIVERSES) {
    assert.equal(typeof u.baseline, "number", `${u.handle} sem baseline`);
    assert.equal(u.active, u.baseline >= 10, `${u.handle}: active=${u.active} mas baseline=${u.baseline}`);
  }
  // 34 ativos depois da ENTREGA 2; Decisão 7 acrescenta KPop Demon Hunters (ativo) → 35.
  assert.equal(FRANCHISE_UNIVERSES.filter((u) => u.active).length, 35);
  assert.equal(FRANCHISE_UNIVERSES.filter((u) => !u.active).length, 5);
  // universos removidos não voltam pela porta das traseiras
  assert.equal(FRANCHISE_UNIVERSES.some((u) => u.handle === "the-mandalorian"), false);
  assert.equal(FRANCHISE_UNIVERSES.some((u) => u.handle === "hello-kitty"), false);
  // Decisão 7 — KPop Demon Hunters, universo próprio, não toca no demon-slayer existente
  const kpop = FRANCHISE_UNIVERSES.find((u) => u.handle === "kpop-demon-hunters");
  assert.ok(kpop, "kpop-demon-hunters em falta");
  assert.equal(kpop.name, "KPop Demon Hunters");
  assert.deepEqual(kpop.refs, ["KPopDemonHunters"]);
  const demonSlayer = FRANCHISE_UNIVERSES.find((u) => u.handle === "demon-slayer");
  assert.deepEqual(demonSlayer.refs, ["Kimetsuno Yaiba"]);
});

check("tabela de Lines: The Mandalorian dentro de Star Wars; invariantes ok", () => {
  assert.equal(FRANCHISE_LINES.length, 1);
  const l = FRANCHISE_LINES[0];
  assert.equal(l.line, "The Mandalorian");
  assert.equal(l.parent, "Star Wars");
  assert.equal(l.handle, "the-mandalorian");
  assert.deepEqual(checkLineInvariants(), []);
});

check("condições versionadas: 41 entradas (40 universos + 1 line), todas NFC", () => {
  assert.equal(FRANCHISE_CONDITIONS.length, 41);
  assert.deepEqual(assertConditionsNFC(), []);
  const manda = FRANCHISE_CONDITIONS.find((c) => c.handle === "the-mandalorian");
  assert.equal(manda.metafield, "alterpop.line");
  assert.equal(manda.condition, "The Mandalorian");
  assert.equal(manda.templateSuffix, "line");
});

check("Lord of the Rings: ref e títulos (incl. produtos 'Hobbit … El Señor de los Anillos')", () => {
  assert.equal(r({ franchiseRefs: ["EL SEÑOR DE LOS ANILLOS"], title: "x" }).handle, "lord-of-the-rings");
  assert.equal(r({ franchiseRefs: [], title: "POP figure Lord of the Rings Pippin Took" }).handle, "lord-of-the-rings");
  assert.equal(r({ franchiseRefs: [], title: "Set regalo cartera Hobbit El Señor de los Anillos" }).handle, "lord-of-the-rings");
});

check("KPop Demon Hunters: ref e título; 'kpop' isolado não resolve (Decisão 7)", () => {
  assert.equal(r({ franchiseRefs: ["KPopDemonHunters"], title: "x" }).handle, "kpop-demon-hunters");
  assert.equal(r({ franchiseRefs: [], title: "KPop Demon Hunters Mira doll" }).handle, "kpop-demon-hunters");
  assert.equal(r({ franchiseRefs: [], title: "Kpop Diva Squad assorted doll 30cm" }).layer, 3);
});

check("handles únicos", () => {
  const h = FRANCHISE_UNIVERSES.map((u) => u.handle);
  assert.equal(new Set(h).size, h.length);
});

check("invariantes de precedência, refs sem colisão, lines ok", () => {
  assert.deepEqual(checkPrecedenceInvariants(), []);
  assert.deepEqual(checkRefIndexCollisions(), []);
  assert.deepEqual(checkLineInvariants(), []);
});

// ── camada 1: refs ─────────────────────────────────────────────────────────────
check("ref 'Onepiece' → One Piece (camada 1)", () => {
  const res = r({ franchiseRefs: ["Onepiece"], title: "irrelevante" });
  assert.equal(res.franchise, "One Piece");
  assert.equal(res.layer, 1);
});

check("ref 'Star Wars' → Star Wars (camada 1), não depende do título", () => {
  const res = r({ franchiseRefs: ["Star Wars"], title: "" });
  assert.equal(res.handle, "star-wars");
  assert.equal(res.layer, 1);
});

check("ref só 'FUNKO' → vazio (FUNKO não é universo)", () => {
  assert.equal(r({ franchiseRefs: ["FUNKO"], title: "Generic box" }).layer, 3);
});

check("ref 'BLACKCLOVER' → vazio (Black Clover não está nos 40)", () => {
  assert.equal(r({ franchiseRefs: ["BLACKCLOVER"], title: "POP Black Clover Secre" }).franchise, null);
});

check("camada 1 vence camada 2 quando ambas dariam resultado", () => {
  const res = r({ franchiseRefs: ["Onepiece"], title: "POP figure Naruto Uzumaki" });
  assert.equal(res.handle, "one-piece");
  assert.equal(res.layer, 1);
});

// ── camada 2: títulos ──────────────────────────────────────────────────────────
check("'Blister 4 figures Bitty POP Sar Wars Luke' → Star Wars", () => {
  const res = r({ franchiseRefs: [], title: "Blister 4 figures Bitty POP Sar Wars Luke" });
  assert.equal(res.handle, "star-wars");
  assert.equal(res.layer, 2);
});

check("'POP figure Ghost Face' → vazio (Scream fora da lista)", () => {
  assert.equal(r({ franchiseRefs: [], title: "POP figure Ghost Face" }).franchise, null);
});

check("Deadpool → X-Men (Tarefa 13b); 'Marvel' sozinho continua fora da lista", () => {
  const res = r({ franchiseRefs: [], title: "POP figure Marvel Deadpool 30th" });
  assert.equal(res.franchise, "X-Men");
  assert.equal(r({ franchiseRefs: ["DEADPOOL"], title: "x" }).franchise, "X-Men");
});

check("Iron Man → Avengers (Tarefa 13b)", () => {
  const res = r({ franchiseRefs: [], title: "Marvel Iron Man metal figure 10cm" });
  assert.equal(res.franchise, "Avengers");
  assert.equal(r({ franchiseRefs: ["IRON MAN"], title: "x" }).franchise, "Avengers");
});

check("Joker → vazio (DC fora da lista)", () => {
  assert.equal(r({ franchiseRefs: [], title: "POP figure DC Joker" }).franchise, null);
});

// ── Lines: Mandalorian dentro de Star Wars (ENTREGA 2) ─────────────────────────
check("'POP figure Star Wars The Mandalorian Grogu' → franchise Star Wars + line The Mandalorian", () => {
  const res = r({ franchiseRefs: [], title: "POP figure Star Wars The Mandalorian Grogu" });
  assert.equal(res.franchise, "Star Wars");
  assert.equal(res.handle, "star-wars");
  assert.equal(res.line, "The Mandalorian");
  assert.equal(res.lineHandle, "the-mandalorian");
});

check("ref 'Mandalorian' isolado → franchise Star Wars (via line→parent), line The Mandalorian, layer 1", () => {
  const res = r({ franchiseRefs: ["Mandalorian"], title: "Bounty Hunter Figure 10cm" });
  assert.equal(res.franchise, "Star Wars");
  assert.equal(res.line, "The Mandalorian");
  assert.equal(res.layer, 1);
});

check("título 'Grogu' isolado → franchise Star Wars, line The Mandalorian, layer 2", () => {
  const res = r({ franchiseRefs: [], title: "POP figure Grogu with cookie" });
  assert.equal(res.franchise, "Star Wars");
  assert.equal(res.line, "The Mandalorian");
  assert.equal(res.layer, 2);
});

check("'Ahsoka' → franchise Star Wars, line The Mandalorian", () => {
  assert.equal(r({ franchiseRefs: [], title: "POP figure Ahsoka Tano" }).line, "The Mandalorian");
});

check("ref/token 'STAR WARS' + título Grogu → Star Wars + line (ref dá o parent, line classifica)", () => {
  const res = r({ franchiseRefs: ["STAR WARS", "PELICULAS"], title: "Star Wars Grogu 3D keychain 6cm" });
  assert.equal(res.franchise, "Star Wars");
  assert.equal(res.handle, "star-wars");
  assert.equal(res.line, "The Mandalorian");
  assert.equal(res.layer, 1);
});

check("Star Wars sem sinal de Mandalorian → sem line", () => {
  const res = r({ franchiseRefs: ["STAR WARS"], title: "Star Wars Darth Vader helmet" });
  assert.equal(res.franchise, "Star Wars");
  assert.equal(res.line, null);
  assert.equal(res.lineHandle, null);
});

check("refs de X-Men + Avengers juntos → X-Men (precedência entre refHits)", () => {
  const res = r({ franchiseRefs: ["Los Vengadores", "Xmen"], title: "figura" });
  assert.equal(res.handle, "x-men");
  assert.equal(res.layer, 1);
});

check("ref 'Star Wars' sem Mandalorian no título → continua Star Wars", () => {
  const res = r({ franchiseRefs: ["STAR WARS"], title: "Star Wars Darth Vader helmet" });
  assert.equal(res.handle, "star-wars");
});

check("título com Avengers + X-Men → X-Men (padrão curto tem de vencer)", () => {
  const res = r({ franchiseRefs: [], title: "POP figure Avengers X-Men Wolverine" });
  assert.equal(res.handle, "x-men");
});

check("título com Avengers + Spider-Man → Spider-Man", () => {
  const res = r({ franchiseRefs: [], title: "POP figure Avengers Spider-Man No Way Home" });
  assert.equal(res.handle, "spider-man");
});

check("Avengers sozinho → Avengers", () => {
  assert.equal(r({ franchiseRefs: [], title: "POP figure Avengers Endgame Thanos" }).handle, "avengers");
});

check("Boruto → universo naruto", () => {
  const res = r({ franchiseRefs: [], title: "POP figure Boruto Naruto Next Generations Sasuke" });
  assert.equal(res.handle, "naruto");
});

// ── ancoragem de padrões curtos ────────────────────────────────────────────────
check("'Lilo & Stitch' → Stitch", () => {
  assert.equal(r({ franchiseRefs: [], title: "POP figure Lilo & Stitch 626" }).handle, "stitch");
});

check("Ghibli: títulos dos filmes resolvem (ref='MANGA', sem ref de franquia)", () => {
  for (const t of [
    "Porco Rosso Savoia S.21 Seaplane model kit",
    "Castle in the Sky Goliath Flying Battleship model kit",
    "Kikis Delivery Service Jiji Cat plush toy 15cm",
    "Princess Mononoke San figure",
    "The Wind Rises Type 9 Fighter Airplane model kit",
  ]) {
    assert.equal(r({ franchiseRefs: ["MANGA"], title: t }).handle, "studio-ghibli", t);
  }
});

check("Ghibli: 'Mononoke' sozinho NÃO resolve (colide com a série Mononoke)", () => {
  assert.equal(r({ franchiseRefs: [], title: "Mononoke Kusuriuri Medicine Seller figure" }).franchise, null);
});

check("Ghibli: 'Howl' sozinho NÃO resolve (palavra comum)", () => {
  assert.equal(r({ franchiseRefs: [], title: "Werewolf Howl at the Moon plush" }).franchise, null);
});

check("Spidey (linha pré-escolar) → Spider-Man, por ref e por título", () => {
  assert.equal(r({ franchiseRefs: ["MARVEL", "spidey"], title: "Marvel Spidey lights sneakers" }).handle, "spider-man");
  assert.equal(r({ franchiseRefs: [], title: "Spidey and His Amazing Friends backpack 27cm" }).handle, "spider-man");
});

check("Hello Kitty / Sanrio ELIMINADO (ENTREGA 2): produtos Sanrio caem na camada 3", () => {
  for (const t of [
    "Hello Kitty classic plush 30cm",
    "Gudetama surprise cup assorted plush toy 26cm",
    "Sumikko Gurashi Friends assorted figure",
    "Rilakkuma Friends surprise figure 5cm",
    "Kuromi adult socks",
  ]) {
    const res = r({ franchiseRefs: ["MANGA", "HELLOKITTY"], title: t });
    assert.equal(res.franchise, null, t);
    assert.equal(res.layer, 3, t);
  }
});

// ── NFC na saída (ENTREGA 2 §4) ───────────────────────────────────────────────
check("franquia sai em NFC: Pokémon = U+00E9 (nunca e + U+0301)", () => {
  const res = r({ franchiseRefs: ["Pokemon"], title: "x" });
  assert.equal(res.franchise, "Pokémon");
  assert.equal(res.franchise, res.franchise.normalize("NFC"));
  assert.equal(res.franchise.length, 7);
});

check("Spy × Family usa U+00D7 (sinal de multiplicação), não a letra x", () => {
  const res = r({ franchiseRefs: ["Spy Xfamily"], title: "x" });
  assert.equal(res.franchise, "Spy × Family");
  assert.ok(res.franchise.includes("×"));
});

check("padrão não apanha dentro de outra palavra", () => {
  // "Set" é prefixo de formato, não universo; "TMNT" não está em "attmntx"
  assert.equal(r({ franchiseRefs: [], title: "Random attmntx widget" }).franchise, null);
});

check("título vazio + sem refs → vazio", () => {
  assert.equal(r({ franchiseRefs: [], title: "" }).layer, 3);
  assert.equal(r({}).layer, 3);
});

// ── gate opcional titleSource ──────────────────────────────────────────────────
check("--supplier-only: título 'pipeline' não corre camada 2", () => {
  const res = resolveFranchise(
    { franchiseRefs: [], title: "One Piece Luffy Gear 5", titleSource: "pipeline" },
    { titleLayerOnlyForSupplierTitles: true }
  );
  assert.equal(res.layer, 3);
  // sem o gate, resolveria
  assert.equal(resolveFranchise({ franchiseRefs: [], title: "One Piece Luffy Gear 5", titleSource: "pipeline" }).handle, "one-piece");
});

// ── stripFormatPrefix ─────────────────────────────────────────────────────────
check("stripFormatPrefix remove um prefixo conhecido", () => {
  assert.equal(stripFormatPrefix("POP figure One Piece Luffy"), "One Piece Luffy");
  assert.equal(stripFormatPrefix("Pocket POP Keychain Batman"), "Batman");
  assert.equal(stripFormatPrefix("Dragon Ball Z Goku"), "Dragon Ball Z Goku"); // sem prefixo, intacto
});

if (failures) {
  console.error(`\n${failures} caso(s) falhados`);
  process.exit(1);
}
console.log("\nfranchise-resolver: todos os casos passaram");
