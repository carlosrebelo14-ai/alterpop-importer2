#!/usr/bin/env node
/**
 * Miniatura do catálogo: a imagem vem da rota da app (por SKU e índice), nunca do URL do fornecedor.
 * Uso: node scripts/tests/catalog-thumbnail-src.test.js
 *
 * Teste estático e de funções puras. Lê o código-fonte e chama as funções com hosts e SKUs sintéticos.
 * Os caminhos podem ser trocados por variáveis de ambiente, para a verificação por mutação
 * (CATALOG_THUMB_COMPONENTE, CATALOG_THUMB_LIB, CATALOG_THUMB_RADAR, CATALOG_THUMB_PAINEL, CATALOG_THUMB_ROTA).
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
  rota: caminho("CATALOG_THUMB_ROTA", "app/routes/api.catalog-image.$sku.$i.jsx"),
};

// Lib do servidor, só para o skuDoCaminho. Este teste não a muta.
const LIB_SERVIDOR = path.join(RAIZ, "lib/catalog/catalogImageProxy.server.js");

// URLs sintéticos. O host não existe; só serve para o teste.
const URL_SINTETICO = "https://imagens.fornecedor-sintetico.example/a.png";
const URL_SINTETICO_B = "https://imagens.fornecedor-sintetico.example/b.png";

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
const importarLib = () => import(pathToFileURL(FICHEIROS.lib).href);

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

await check("V6: todo src usa urlDaImagemDoCatalogo(sku, indice, images[indice]), nunca imageUrl", () => {
  const srcs = [...lerComponente().matchAll(/\bsrc=\{([^}]*)\}/g)].map((m) => m[1].trim());
  assert.ok(srcs.length >= 3, `esperava pelo menos 3 atributos src (miniatura, modal, tiras), encontrei ${srcs.length}`);
  for (const expr of srcs) {
    // O índice do src tem de ser o mesmo que o de images[...]. Com dois argumentos não bate.
    assert.match(
      expr,
      /^urlDaImagemDoCatalogo\(sku,\s*([^,()]+),\s*images\[\1\]\)$/,
      `src não usa urlDaImagemDoCatalogo com três argumentos: {${expr}}`
    );
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

await check("V1: versaoDaUrl dá 8 caracteres hexadecimais, igual para o mesmo URL e diferente com um caractere a mais", async () => {
  const lib = await importarLib();
  const versao = lib.versaoDaUrl(URL_SINTETICO);
  assert.match(versao, /^[0-9a-f]{8}$/, "a versão não tem 8 caracteres hexadecimais");
  assert.equal(lib.versaoDaUrl(URL_SINTETICO), versao, "o mesmo URL deu versões diferentes");
  assert.notEqual(lib.versaoDaUrl(`${URL_SINTETICO}x`), versao, "um caractere a mais deu a mesma versão");
});

await check("versaoDaUrl é FNV-1a de 32 bits (valores de referência)", async () => {
  // Valores calculados à parte com duas implementações independentes (Math.imul e BigInt).
  const lib = await importarLib();
  assert.equal(lib.versaoDaUrl(""), "811c9dc5", "a base do FNV-1a não bate");
  assert.equal(lib.versaoDaUrl(URL_SINTETICO), "49c67fb1", "o hash do URL sintético A não bate");
  assert.equal(lib.versaoDaUrl(URL_SINTETICO_B), "624807d8", "o hash do URL sintético B não bate");
});

await check("V2: urlDaImagemDoCatalogo(sku, 2, url) dá o prefixo, o sku codificado, o índice e o ?v= desse URL", async () => {
  const lib = await importarLib();
  assert.equal(
    lib.urlDaImagemDoCatalogo("SKU-SINTETICO/1", 2, URL_SINTETICO),
    "/api/catalog-image/SKU-SINTETICO%2F1/2?v=49c67fb1"
  );
});

await check("V3: urlOrigem vazio ou que não seja string lança TypeError", async () => {
  const lib = await importarLib();
  for (const valor of ["", null, undefined, 42, {}, []]) {
    // A mensagem tem de vir da guarda. Sem ela, null e undefined também dariam TypeError, por outra razão.
    assert.throws(
      () => lib.urlDaImagemDoCatalogo("SKU-SINTETICO/1", 0, valor),
      (err) => err instanceof TypeError && /urlOrigem/.test(err.message),
      `não lançou TypeError da guarda para um valor do tipo ${typeof valor}`
    );
  }
});

await check("V4: a versão muda quando o URL muda na mesma posição", async () => {
  const lib = await importarLib();
  const listaA = lib.resolveAllProductImages(URL_SINTETICO);
  const listaB = lib.resolveAllProductImages(URL_SINTETICO_B);
  assert.equal(listaA.length, 1, "a lista A devia ter uma imagem");
  assert.equal(listaB.length, 1, "a lista B devia ter uma imagem");
  const urlA = lib.urlDaImagemDoCatalogo("SKU-SINTETICO/1", 0, listaA[0]);
  const urlB = lib.urlDaImagemDoCatalogo("SKU-SINTETICO/1", 0, listaB[0]);
  assert.notEqual(urlA, urlB, "o mesmo índice com URL de origem diferente deu o mesmo URL");
});

await check("V5: skuDoCaminho com a query ?v= devolve o mesmo SKU (a rota ignora a query)", async () => {
  const libServidor = await import(pathToFileURL(LIB_SERVIDOR).href);
  const semQuery = "/api/catalog-image/SKU-SINTETICO%2F1/2";
  const comQuery = `${semQuery}?v=49c67fb1`;
  // A rota usa só o pathname do URL do pedido. Faz-se o mesmo aqui.
  const pathname = new URL(comQuery, "http://localhost").pathname;
  assert.equal(pathname, semQuery, "o pathname devia perder a query");
  assert.equal(libServidor.skuDoCaminho(pathname), "SKU-SINTETICO/1");
  assert.equal(libServidor.skuDoCaminho(semQuery), "SKU-SINTETICO/1");
});

await check("V5 (rota, só leitura): a rota passa skuDoCaminho(new URL(request.url).pathname), nunca request.url inteiro", () => {
  const texto = fs.readFileSync(FICHEIROS.rota, "utf8");
  assert.match(
    texto,
    /skuDoCaminho\(\s*new URL\(request\.url\)\.pathname\s*\)/,
    "a rota não passa só o pathname a skuDoCaminho"
  );
  assert.doesNotMatch(texto, /skuDoCaminho\(\s*request\.url\s*\)/, "a rota passa o URL inteiro a skuDoCaminho");
});

// URLs sintéticos com hash de zero à esquerda (foto-7) e com o bit de sinal ligado (foto-0).
const URL_SINTETICO_FOTO_7 = "https://imagens.fornecedor-sintetico.example/foto-7.jpg";
const URL_SINTETICO_FOTO_0 = "https://imagens.fornecedor-sintetico.example/foto-0.jpg";

await check("V7: versaoDaUrl sai sempre com 8 hexadecimais, com zero à esquerda e sem sinal", async () => {
  const lib = await importarLib();
  // Valores calculados à parte com BigInt. Com o padStart ou o >>> 0 em falta, estes dois casos falham.
  assert.equal(lib.versaoDaUrl(URL_SINTETICO_FOTO_7), "043db6c6", "o hash com zero à esquerda não saiu com 8 caracteres");
  assert.equal(lib.versaoDaUrl(URL_SINTETICO_FOTO_0), "9d85ec9b", "o hash com bit de sinal saiu com sinal");
  for (const url of [URL_SINTETICO, URL_SINTETICO_B, URL_SINTETICO_FOTO_7, URL_SINTETICO_FOTO_0]) {
    assert.match(lib.versaoDaUrl(url), /^[0-9a-f]{8}$/, "a versão não tem 8 caracteres hexadecimais");
  }
});

await check("V8: resolveAllProductImages dá a mesma lista com array e com string (protocolo relativo e repetidos)", async () => {
  const lib = await importarLib();
  const comoArray = lib.resolveAllProductImages(["//imagens.fornecedor-sintetico.example/a.png", URL_SINTETICO]);
  const comoString = lib.resolveAllProductImages(`//imagens.fornecedor-sintetico.example/a.png,${URL_SINTETICO}`);
  assert.deepEqual(comoArray, comoString, "o array e a string dão listas diferentes");
  assert.deepEqual(comoArray, [URL_SINTETICO], "o protocolo relativo não ficou https, ou o repetido não saiu");
});

await check("V9: o modal usa um índice dentro da lista, mesmo que a lista tenha encolhido com o modal aberto", () => {
  const src = lerComponente();
  assert.match(
    src,
    /const\s+idxAtivo\s*=\s*activeIdx\s*<\s*images\.length\s*\?\s*activeIdx\s*:\s*0\s*;/,
    "falta o índice limitado à lista"
  );
  assert.match(
    src,
    /src=\{urlDaImagemDoCatalogo\(sku,\s*idxAtivo,\s*images\[idxAtivo\]\)\}/,
    "a imagem do modal não usa o índice limitado"
  );
});

await check("V10: um erro da miniatura pede a imagem outra vez, com pausa de 5 s, antes de desistir", () => {
  const src = lerComponente();
  assert.match(src, /const\s+PAUSA_MS\s*=\s*5000\s*;/, "a pausa não é de 5 s, o Retry-After da rota");
  assert.match(src, /setTimeout\(\(\)\s*=>\s*setAguarda\(false\),\s*PAUSA_MS\)/, "falta a pausa antes da nova tentativa");
  assert.match(src, /onError=\{\(\)\s*=>\s*\{[\s\S]*?setAguarda\(true\)/, "o erro não agenda uma nova tentativa");
  assert.doesNotMatch(src, /setFailed\(true\)/, "o erro ainda deixa a miniatura definitiva logo na primeira falha");
});

if (falhas) {
  console.error(`\n${falhas} falha(s)`);
  process.exit(1);
}
console.log("\ncatalog-thumbnail-src: todas as asserções passaram");
