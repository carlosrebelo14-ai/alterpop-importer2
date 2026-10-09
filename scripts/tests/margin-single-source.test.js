#!/usr/bin/env node
/**
 * Briefing de integridade (09/10/2026), A2 — uma só fonte da margem e do preço da linha.
 *
 * 1. Comportamento: priceRow (o ponto único de painel, export, staging, import de edições
 *    e reconciliação) dá ao Gandalf (889698135504) 14,50 a 10 % e 14,90 a 20 %, com a
 *    margem do produto a ganhar à global e a margem inválida a dar erro à vista.
 * 2. Estrutura: quem resolve a margem global ou lê o override do produto é uma lista
 *    FECHADA de ficheiros. Um ficheiro novo a ler margem por conta própria (a segunda
 *    fonte) faz o teste falhar — acrescentá-lo à lista é uma decisão consciente.
 * Uso: node scripts/tests/margin-single-source.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { priceRow, resolveMarginPct } from "../../lib/importer/pricing/pricing.server.js";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FALHA  ${name}\n    ${err.message}`);
  }
}

// Gandalf: custo 9,99 s/IVA → 12,09 c/IVA; PVPR 17,95.
check("Gandalf a 10 % = 14,50 (PISO_PVPR), a 20 % = 14,90 (MARGEM)", () => {
  const a = priceRow(9.99, 17.95, 10, null);
  assert.equal(a.finalPrice, 14.5);
  assert.equal(a.priceStatus, "PISO_PVPR");
  assert.equal(a.marginPct, 10);
  const b = priceRow(9.99, 17.95, 20, null);
  assert.equal(b.finalPrice, 14.9);
  assert.equal(b.priceStatus, "MARGEM");
});
check("margem do produto ganha à global", () => {
  const r = priceRow(9.99, 17.95, 10, { metadata: { overrides: { marginPct: 20 } } });
  assert.equal(r.finalPrice, 14.9);
  assert.equal(r.marginPct, 20);
});
check("margem do produto inválida → priceError e marginError, nunca a global", () => {
  const r = priceRow(9.99, 17.95, 10, { metadata: { overrides: { marginPct: 150 } } });
  assert.equal(r.finalPrice, null);
  assert.ok(r.marginError && r.priceError === r.marginError);
  assert.equal(r.marginPct, null);
});
check("sem custo → priceError, sem lançar", () => {
  const r = priceRow(null, 17.95, 10, null);
  assert.equal(r.finalPrice, null);
  assert.ok(r.priceError);
});
check("margem global por definir (null) lança em resolveMarginPct", () => {
  assert.throws(() => resolveMarginPct({ priceMarginPct: null }));
});

// --- Estrutura -------------------------------------------------------------------
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|jsx)$/.test(e.name)) out.push(p);
  }
  return out;
}
const files = [...walk(path.join(ROOT, "app")), ...walk(path.join(ROOT, "lib"))].map((f) => path.relative(ROOT, f));

function filesMatching(re) {
  return files.filter((f) => re.test(fs.readFileSync(path.join(ROOT, f), "utf8"))).sort();
}

const ALLOWED = {
  // chamadas a productMarginPct(...) / resolveMarginPct(...)
  resolve: [
    "app/routes/api.products.import-edits.jsx",
    "lib/importer/catalog/catalogProductsDb.server.js",
    "lib/importer/importers/ProductImporter.js",
    "lib/importer/pricing/pricing.server.js",
    "lib/importer/shopify/shopifyApprovedSync.server.js",
    "lib/importer/shopify/publishedReprice.server.js",
    "lib/importer/shopify/shopifyProductPublisher.server.js",
    "lib/importer/sync/syncStagingSummary.server.js",
  ],
  // leitura de metadata.overrides.marginPct
  override: [
    "lib/importer/catalog/catalogProductsDb.server.js",
    "lib/importer/importers/ProductImporter.js",
    "lib/importer/pricing/pricing.server.js",
    "lib/importer/shopify/shopifyProductPublisher.server.js",
  ],
  // leitura/escrita de settings.priceMarginPct
  setting: [
    "app/routes/app._index.jsx",
    "app/routes/app.settings.jsx",
    "lib/importer/pricing/pricing.server.js",
    "lib/importer/settings.server.js",
    "lib/importer/shopify/shopifyMapper.server.js",
  ],
};

function assertClosed(label, found, allowed) {
  const extra = found.filter((f) => !allowed.includes(f));
  assert.deepEqual(
    extra,
    [],
    `${label}: ficheiro(s) novo(s) a ler a margem por conta própria — usar priceRow (pricing.server.js) ou, se for mesmo preciso, acrescentar à lista ALLOWED: ${extra.join(", ")}`
  );
}

check("só a lista fechada resolve a margem (productMarginPct/resolveMarginPct)", () =>
  assertClosed("resolve", filesMatching(/\b(productMarginPct|resolveMarginPct)\(/), ALLOWED.resolve));
check("só a lista fechada lê overrides.marginPct", () =>
  assertClosed("override", filesMatching(/overrides\??\.marginPct/), ALLOWED.override));
check("só a lista fechada lê priceMarginPct", () =>
  assertClosed("setting", filesMatching(/priceMarginPct/), ALLOWED.setting));
check("painel, export, staging, import de edições e reconciliação usam priceRow", () => {
  for (const f of [
    "lib/importer/catalog/catalogProductsDb.server.js",
    "lib/importer/sync/syncStagingSummary.server.js",
    "app/routes/api.products.import-edits.jsx",
    "lib/importer/pricing/priceReconcile.server.js",
  ]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.ok(/\bpriceRow\(/.test(src), `${f} não usa priceRow`);
    assert.ok(!/\bproductMarginPct\(/.test(src.replace(/productMarginPct:/g, "")), `${f} chama productMarginPct à parte`);
  }
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
