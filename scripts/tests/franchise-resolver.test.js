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
} from "../../lib/importer/catalog/franchiseResolver.server.js";
import { FRANCHISE_UNIVERSES } from "../../lib/importer/catalog/franchiseUniverses.js";

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
check("tabela tem 40 universos, 30 ativos / 10 dormentes", () => {
  assert.equal(FRANCHISE_UNIVERSES.length, 40);
  assert.equal(FRANCHISE_UNIVERSES.filter((u) => u.active).length, 30);
  assert.equal(FRANCHISE_UNIVERSES.filter((u) => !u.active).length, 10);
});

check("handles únicos", () => {
  const h = FRANCHISE_UNIVERSES.map((u) => u.handle);
  assert.equal(new Set(h).size, h.length);
});

check("invariantes de precedência e refs sem colisão", () => {
  assert.deepEqual(checkPrecedenceInvariants(), []);
  assert.deepEqual(checkRefIndexCollisions(), []);
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

check("Deadpool → vazio (Marvel fora da lista de universos)", () => {
  assert.equal(r({ franchiseRefs: [], title: "POP figure Marvel Deadpool 30th" }).franchise, null);
});

check("Joker → vazio (DC fora da lista)", () => {
  assert.equal(r({ franchiseRefs: [], title: "POP figure DC Joker" }).franchise, null);
});

// ── precedência ────────────────────────────────────────────────────────────────
check("'POP figure Star Wars The Mandalorian Grogu' → The Mandalorian, NÃO Star Wars", () => {
  const res = r({ franchiseRefs: [], title: "POP figure Star Wars The Mandalorian Grogu" });
  assert.equal(res.handle, "the-mandalorian");
});

check("ref/token 'Star Wars' + título Mandalorian → The Mandalorian (precedência na camada 1)", () => {
  // 231 casos no catálogo real: produto com o token 'STAR WARS' em franchises[] mas
  // título "Star Wars Grogu ...". A camada 1 tem de respeitar a precedência, não
  // devolver Star Wars só porque o ref bateu primeiro.
  const res = r({ franchiseRefs: ["STAR WARS", "PELICULAS"], title: "Star Wars Grogu 3D keychain 6cm" });
  assert.equal(res.handle, "the-mandalorian");
  assert.equal(res.layer, 1);
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
