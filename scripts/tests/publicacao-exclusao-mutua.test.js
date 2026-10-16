#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-105. Exclusão mútua entre publicações, com o motor real. O ciclo agendado e a publicação manual não
 * podem criar o mesmo produto duas vezes. O publicador falso tem a janela de corrida real: procura se o SKU
 * já existe, espera 30 ms e só então cria. Duas corridas em simultâneo devem dar uma criação por SKU, sem
 * alerta 'Publicado na Shopify' (metadata.alertaPublicadoNaShopify, escrito quando o item já não está APPROVED
 * ao marcar: é o duplicado que chega depois da primeira corrida).
 * Uso: node scripts/tests/publicacao-exclusao-mutua.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "publicacao-exclusao-"));
process.env.CURATION_DATA_DIR = tmp;
process.env.PROJECT_ROOT = tmp;
process.env.DATABASE_URL = `file:${path.join(tmp, "dev.sqlite")}`;
process.chdir(tmp);
// O upsert do worker lê config/ relativo ao cwd: ligo-o ao repo dentro do diretório temporário.
fs.symlinkSync(path.join(ROOT, "config"), path.join(tmp, "config"));
fs.mkdirSync(path.join(tmp, "server", "data"), { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, "server", "data"))) {
  if (f !== "curation-queue.json") fs.copyFileSync(path.join(ROOT, "server", "data", f), path.join(tmp, "server", "data", f));
}

const q = await import(path.join(ROOT, "lib/curation/curationQueue.server.js"));
const engine = await import(path.join(ROOT, "lib/importer/shopify/shopifyApprovedSync.server.js"));

const QUEUE = path.join(tmp, "curation-queue.json");
const SHOP = "exclusao-mutua.myshopify.com";
const SESSAO = { shop: SHOP, accessToken: "token-de-teste" };
const SKUS = ["M1", "M2", "M3"];

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

function escreverFila(items) {
  fs.writeFileSync(QUEUE, JSON.stringify({ version: 1, updatedAt: null, items }), "utf8");
  q.invalidateCurationMemoryCache();
}

function item(sku, status = "APPROVED") {
  return { sku, title_en: sku, status, reason: "teste", shopifyStatus: "DRAFT", metadata: {} };
}

async function itemNaFila(sku) {
  return (await q.loadCurationQueue()).items.find((i) => i.sku === sku);
}

/** Dependências de teste: só o publicador é o ponto da verificação. O resto deixa passar as guardas. */
function dependencias(publicar) {
  return {
    publicar,
    sessaoOffline: async () => SESSAO,
    verificarFranquias: async () => {},
    verificarTema: async () => {},
    garantirMetafields: async () => false,
    carregarCatalogo: async (_shop, skus) => skus.map((sku) => ({ sku, netPrice: 10, grossPrice: 12 })),
  };
}

/**
 * Publicador falso com a janela de corrida. A procura (o SKU já existe?) é feita antes da espera e a criação
 * depois. Duas corridas que procuram ao mesmo tempo veem o SKU por criar e criam os dois.
 */
function publicadorComJanela(criados, existentes) {
  return async (_client, row) => {
    const jaExiste = existentes.has(row.sku);
    await new Promise((r) => setTimeout(r, 30));
    if (!jaExiste) {
      criados.push(row.sku);
      existentes.add(row.sku);
    }
    return { shopifyProductId: `gid://shopify/Product/${row.sku}` };
  };
}

function duplicados(criados) {
  const porSku = new Map();
  for (const sku of criados) porSku.set(sku, (porSku.get(sku) || 0) + 1);
  return [...porSku.values()].reduce((total, n) => total + Math.max(0, n - 1), 0);
}

console.log("DBG-105 — exclusão mútua entre publicações (motor real, publicador com janela de corrida)");

await check("duas corridas em simultâneo: uma criação por SKU, uma corrida fica de fora", async () => {
  escreverFila(SKUS.map((sku) => item(sku)));
  const criados = [];
  const existentes = new Set();
  const publicar = publicadorComJanela(criados, existentes);
  const [a, b] = await Promise.all([
    engine.runApprovedShopifySync(SESSAO, { skipInit: true, dependencias: dependencias(publicar) }),
    engine.runApprovedShopifySync(SESSAO, { skipInit: true, dependencias: dependencias(publicar) }),
  ]);
  console.log(`      criações: ${criados.length}, duplicados: ${duplicados(criados)}`);
  assert.equal(duplicados(criados), 0, `duplicados: ${duplicados(criados)} (criações: ${criados.join(", ")})`);
  assert.equal(criados.length, SKUS.length, "uma criação por SKU");
  const ocupadas = [a, b].filter((r) => r?.reason === "publish_already_running");
  assert.equal(ocupadas.length, 1, "uma das corridas fica de fora, com a razão publish_already_running");
});

await check("nenhum alerta 'Publicado na Shopify' depois da corrida em simultâneo", async () => {
  for (const sku of SKUS) {
    const it = await itemNaFila(sku);
    assert.equal(it.status, "PUBLISHED", `${sku} fica PUBLISHED`);
    assert.equal(it.metadata?.alertaPublicadoNaShopify, undefined, `${sku} sem alerta falso`);
  }
});

await check("depois da libertação, uma nova corrida não fica bloqueada", async () => {
  escreverFila([item("L1")]);
  const criados = [];
  const res = await engine.runApprovedShopifySync(SESSAO, {
    skipInit: true,
    dependencias: dependencias(publicadorComJanela(criados, new Set())),
  });
  assert.notEqual(res?.reason, "publish_already_running", "a reserva libertada não pode ficar presa");
  assert.deepEqual(criados, ["L1"], "a nova corrida publica o SKU aprovado");
});

fs.rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.error(`\npublicacao-exclusao-mutua: ${failures} verificação(ões) falharam`);
  process.exit(1);
}
console.log("\npublicacao-exclusao-mutua: todos os casos passaram");
