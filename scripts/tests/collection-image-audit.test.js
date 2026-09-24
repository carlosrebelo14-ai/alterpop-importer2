#!/usr/bin/env node
/**
 * B14 (briefing backend, 24/09/2026), secção 8 — collection-image-audit.js,
 * auditCollectionImages (parte pura, sem Shopify/fs). Caso real: regressão Star Wars
 * (18/09/2026) — collection.image não quadrada, logo esticado nas tiles.
 * Uso: node scripts/tests/collection-image-audit.test.js
 */
import assert from "node:assert/strict";
import { auditCollectionImages } from "../../lib/importer/shopify/collectionImageAudit.js";

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

function node({ handle, image, heroImage }) {
  return {
    handle,
    title: handle,
    templateSuffix: "universe-room",
    image,
    heroImage: heroImage ? { reference: { image: heroImage } } : null,
  };
}

check("collection.image quadrada não é marcada", () => {
  const result = auditCollectionImages(node({ handle: "batman", image: { url: "x.png", width: 800, height: 800, altText: "Batman" } }));
  assert.equal(result.nonSquare, false);
  assert.equal(result.image.width, 800);
});

check("collection.image não quadrada é marcada (caso real: regressão Star Wars, 18/09/2026)", () => {
  const result = auditCollectionImages(node({ handle: "star-wars", image: { url: "x.png", width: 1600, height: 900, altText: null } }));
  assert.equal(result.nonSquare, true);
});

check("sem collection.image: image=null, nunca marcada (falta de dado != defeito)", () => {
  const result = auditCollectionImages(node({ handle: "gundam", image: null }));
  assert.equal(result.image, null);
  assert.equal(result.nonSquare, false);
});

check("width/height ausentes (upload recente): não marca, evita falso positivo", () => {
  const result = auditCollectionImages(node({ handle: "naruto", image: { url: "x.png", width: null, height: null, altText: null } }));
  assert.equal(result.nonSquare, false);
});

check("alterpop.hero_image presente é extraído (MediaImage.image)", () => {
  const result = auditCollectionImages(
    node({
      handle: "one-piece",
      image: { url: "tile.png", width: 800, height: 800, altText: "One Piece" },
      heroImage: { url: "hero.png", width: 2400, height: 1000, altText: "One Piece hero" },
    })
  );
  assert.equal(result.heroImage.url, "hero.png");
  assert.equal(result.heroImage.width, 2400);
});

check("sem alterpop.hero_image: heroImage=null", () => {
  const result = auditCollectionImages(node({ handle: "gundam", image: null, heroImage: null }));
  assert.equal(result.heroImage, null);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\ncollection-image-audit: todos os casos passaram");
