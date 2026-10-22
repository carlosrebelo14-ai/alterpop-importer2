#!/usr/bin/env node
/**
 * Miniatura do catálogo: a imagem vem da rota da app (por SKU e índice), nunca do URL do fornecedor.
 * Uso: node scripts/tests/catalog-thumbnail-src.test.js
 *
 * Teste estático: lê o código-fonte e confirma as regras. Não gera URLs reais, só um SKU sintético.
 * Os caminhos podem ser trocados por variáveis de ambiente, para a verificação por mutação
 * (CATALOG_THUMB_COMPONENTE, CATALOG_THUMB_LIB, CATALOG_THUMB_RADAR, CATALOG_THUMB_PAINEL).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function caminho(variavel, relativo) {
  return process.env[variavel] || path.join(RAIZ, relativo);
}

const FICHEIROS = {
  componente: caminho("CATALOG_THUMB_COMPONENTE", "app/components/CatalogProductThumbnail.jsx"),
  lib: caminho("CATALOG_THUMB_LIB", "lib/catalog/productImages.js"),
  radar: caminho("CATALOG_THUMB_RADAR", "app/components/IndexingRadarSheet.jsx"),
  painel: caminho("CATALOG_THUMB_PAINEL", "app/routes/app._index.jsx"),
};

let falhas = 0;

async function check(nome, fn) {
  try {
    await fn();
    console.log(`  ok  ${nome}`);
  } catch (err) {
    falhas += 1;
    console.error(`FAIL  ${nome}\n      ${err.message}`);
  }
}

const lerComponente = () => fs.readFileSync(FICHEIROS.componente, "utf8");

await check("componente importa resolveAllProductImages e urlDaImagemDoCatalogo de lib/catalog/productImages.js", () => {
  const src = lerComponente();
  const m = src.match(/import\s*\{([^}]*)\}\s*from\s*"\.\.\/\.\.\/lib\/catalog\/productImages\.js"/);
  assert.ok(m, "não há import de ../../lib/catalog/productImages.js");
  const nomes = m[1].split(",").map((s) => s.trim()).filter(Boolean);
  assert.ok(nomes.includes("resolveAllProductImages"), "falta resolveAllProductImages no import");
  assert.ok(nomes.includes("urlDaImagemDoCatalogo"), "falta urlDaImagemDoCatalogo no import");
  assert.doesNotMatch(src, /function\s+resolveAllProductImages\s*\(/, "resolveAllProductImages ainda está definida localmente");
  assert.doesNotMatch(src, /function\s+resolveProductImageSource\s*\(/, "resolveProductImageSource ainda está definida localmente");
});

await check("componente reexporta resolveAllProductImages e resolveProductImageSource com os mesmos nomes", () => {
  assert.match(
    lerComponente(),
    /export\s*\{\s*resolveAllProductImages\s*,\s*resolveProductImageSource\s*\}/,
    "falta o export com os dois nomes"
  );
});

await check("a imagem vem sempre da rota: todo src passa por urlDaImagemDoCatalogo(sku, indice), nunca por imageUrl", () => {
  const srcs = [...lerComponente().matchAll(/\bsrc=\{([^}]*)\}/g)].map((m) => m[1].trim());
  assert.ok(srcs.length >= 3, `esperava pelo menos 3 atributos src (miniatura, modal, tiras), encontrei ${srcs.length}`);
  for (const expr of srcs) {
    assert.match(expr, /^urlDaImagemDoCatalogo\(sku,\s*[^()]+\)$/, `src não passa pela rota: {${expr}}`);
  }
});

await check("app/routes/app._index.jsx passa sku={sku} à miniatura", () => {
  const src = fs.readFileSync(FICHEIROS.painel, "utf8");
  assert.match(src, /<CatalogProductThumbnail\b[^>]*\bsku=\{sku\}/, "a chamada de CatalogProductThumbnail não recebe sku={sku}");
});

await check("app/components/IndexingRadarSheet.jsx passa sku={p.sku} à miniatura", () => {
  const src = fs.readFileSync(FICHEIROS.radar, "utf8");
  assert.match(src, /<CatalogProductThumbnail\b[^>]*\bsku=\{p\.sku\}/, "a chamada de CatalogProductThumbnail não recebe sku={p.sku}");
});

await check("sem imagens, sem sku ou com erro de carregamento o componente mostra o placeholder", () => {
  assert.match(
    lerComponente(),
    /if\s*\(\s*images\.length\s*===\s*0\s*\|\|\s*!sku\s*\|\|\s*failed\s*\)/,
    "a guarda do placeholder não cobre as três situações"
  );
});

await check('urlDaImagemDoCatalogo("SKU-SINTETICO/1", 2) dá /api/catalog-image/SKU-SINTETICO%2F1/2', async () => {
  const lib = await import(pathToFileURL(FICHEIROS.lib).href);
  assert.equal(lib.urlDaImagemDoCatalogo("SKU-SINTETICO/1", 2), "/api/catalog-image/SKU-SINTETICO%2F1/2");
});

if (falhas) {
  console.error(`\n${falhas} falha(s)`);
  process.exit(1);
}
console.log("\ncatalog-thumbnail-src: todas as asserções passaram");
