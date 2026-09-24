#!/usr/bin/env node
/**
 * B14 (briefing backend, 24/09/2026) — collection-description-clean.js.
 * Casos reais: descriptionHtml com <p> à volta, travessão como entidade HTML, e a
 * copy editorial (universeCollectionCopy.js) como negativo.
 * Uso: node scripts/tests/collection-description-clean.test.js
 */
import assert from "node:assert/strict";
import {
  stripHtml,
  matchPlaceholder,
} from "../../lib/importer/shopify/collectionDescriptionPlaceholder.js";

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

check("matchPlaceholder — bate no placeholder universe com <p> real", () => {
  const html =
    "<p>Coleção Universe — produtos com alterpop.franchise = Batman. Rascunho: confirmar e publicar no Admin.</p>";
  assert.equal(matchPlaceholder(html)?.name, "universe");
});

check("matchPlaceholder — bate no placeholder auto com <p> real", () => {
  const html = "<p>Coleção criada automaticamente — produtos com licença Batman.</p>";
  assert.equal(matchPlaceholder(html)?.name, "auto");
});

check("matchPlaceholder — bate com o travessão em entidade &mdash;", () => {
  const html = "<p>Coleção Universe &mdash; produtos com alterpop.franchise = Batman.</p>";
  assert.equal(matchPlaceholder(html)?.name, "universe");
});

check("matchPlaceholder — bate com o travessão em entidade numérica &#8212;", () => {
  const html = "<p>Coleção criada automaticamente &#8212; produtos com licença Batman.</p>";
  assert.equal(matchPlaceholder(html)?.name, "auto");
});

check("matchPlaceholder — bate com o travessão em entidade hex &#x2014;", () => {
  const html = "<p>Coleção Universe &#x2014; produtos com alterpop.franchise = Batman.</p>";
  assert.equal(matchPlaceholder(html)?.name, "universe");
});

check("matchPlaceholder — não dispara na copy editorial (caso real: Batman)", () => {
  const html =
    "<p>I'm Batman. Explore the Batman universe with figures, t-shirts, accessories and decor of the Dark Knight, Gotham City and his rogues' gallery. For fans of the Caped Crusader, from every generation.</p>";
  assert.equal(matchPlaceholder(html), null);
});

check("matchPlaceholder — não dispara em descrição vazia", () => {
  assert.equal(matchPlaceholder(""), null);
  assert.equal(matchPlaceholder(null), null);
});

check("stripHtml — remove tags e descodifica entidades", () => {
  assert.equal(
    stripHtml("<p>A &amp; B &mdash; C&nbsp;D</p>"),
    "A & B — C D"
  );
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\ncollection-description-clean: todos os casos passaram");
