#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-04, Decisão 2 do arquiteto: a publicação relê o estado antes de criar cada produto e só marca
 * PUBLISHED se o item continuar APPROVED. Usa a fila real em ficheiros temporários e um publicador
 * falso (opts.dependencias) que controla o momento da criação, sem rede nem base de dados:
 *   (a) rejeição antes da criação: o produto não é criado e o SKU fica como saltado;
 *   (b) rejeição depois da criação: o item fica REJECTED, nunca PUBLISHED, com alerta no metadata;
 *   (c) o erro de sincronização não sobrepõe uma decisão humana;
 *   (d) caminhos normais continuam: APPROVED publicado fica PUBLISHED, erro sem decisão fica SYNC_ERROR;
 *   (e) a leitura antes de criar é do disco, não da cache em memória.
 * Uso: node scripts/tests/shopify-publish-human-decision.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "publish-human-decision-"));
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
const SHOP = "human-decision.myshopify.com";
const SESSAO = { shop: SHOP, accessToken: "token-de-teste" };

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

console.log("Decisão 2 — a publicação não cria nem marca produtos de SKU que deixou de estar APPROVED");

await check("(a) rejeição antes da criação: SKU rejeitado durante a corrida não cria produto", async () => {
  escreverFila([item("A1"), item("A2")]);
  const criados = [];
  const publicar = async (_client, row) => {
    criados.push(row.sku);
    if (row.sku === "A1") await q.rejectProduct("A2", {});
    return { shopifyProductId: `gid://shopify/Product/${row.sku}` };
  };
  const res = await engine.runApprovedShopifySync(SESSAO, { dependencias: dependencias(publicar) });
  assert.equal(res.ok, true);
  assert.deepEqual(criados, ["A1"], "o publicador não pode ser chamado para A2, que foi rejeitado");
  assert.equal(res.saltados, 1, "A2 conta como saltado, não como falha");
  assert.equal(res.failed, 0);
  assert.equal((await itemNaFila("A2")).status, "REJECTED");
  assert.equal((await itemNaFila("A1")).status, "PUBLISHED");
});

await check("(b) rejeição depois da criação: item fica REJECTED, nunca PUBLISHED, com alerta no metadata", async () => {
  escreverFila([item("B1")]);
  const publicar = async (_client, row) => {
    // A Shopify já criou o produto. A decisão humana chega antes de a corrida marcar o resultado.
    await q.rejectProduct(row.sku, {});
    return { shopifyProductId: "gid://shopify/Product/901" };
  };
  await engine.runApprovedShopifySync(SESSAO, { dependencias: dependencias(publicar) });
  const b1 = await itemNaFila("B1");
  assert.equal(b1.status, "REJECTED", "a decisão humana mantém-se");
  assert.notEqual(b1.status, "PUBLISHED");
  assert.equal(b1.metadata.alertaPublicadoNaShopify.shopifyProductId, "gid://shopify/Product/901");
  assert.ok(b1.metadata.alertaPublicadoNaShopify.em, "o alerta leva a data");
  assert.equal(b1.metadata.shopifyProductId, undefined, "sem vínculo à Shopify no item: sem despublicação automática");
});

await check("(a2) nova tentativa depois de sessão inválida: relê antes de criar e não cria se foi rejeitado", async () => {
  escreverFila([item("R1")]);
  const chamadas = [];
  const publicar = async (_client, row) => {
    chamadas.push(row.sku);
    // Primeira criação falha por sessão inválida, e a decisão humana chega nesse intervalo.
    await q.rejectProduct(row.sku, {});
    throw new Error("401 Unauthorized (teste)");
  };
  const res = await engine.runApprovedShopifySync(SESSAO, { dependencias: dependencias(publicar) });
  assert.deepEqual(chamadas, ["R1"], "a nova tentativa não pode criar o produto de um SKU rejeitado");
  assert.equal(res.saltados, 1);
  assert.equal(res.failed, 0);
  assert.equal((await itemNaFila("R1")).status, "REJECTED");
});

await check("(c) erro de sincronização não sobrepõe uma decisão humana tomada durante a corrida", async () => {
  escreverFila([item("C1")]);
  const publicar = async (_client, row) => {
    await q.rejectProduct(row.sku, {});
    throw new Error("Produto recusado pela Shopify (teste)");
  };
  const res = await engine.runApprovedShopifySync(SESSAO, { dependencias: dependencias(publicar) });
  assert.equal(res.failed, 1);
  const c1 = await itemNaFila("C1");
  assert.equal(c1.status, "REJECTED", "SYNC_ERROR não pode sobrepor REJECTED");
  assert.equal(c1.metadata.syncError ?? null, null);
});

console.log("Caminhos normais continuam iguais");

await check("(d) APPROVED publicado sem decisão humana fica PUBLISHED, sem alerta", async () => {
  escreverFila([item("D1")]);
  const publicar = async () => ({ shopifyProductId: "gid://shopify/Product/42" });
  const res = await engine.runApprovedShopifySync(SESSAO, { dependencias: dependencias(publicar) });
  assert.equal(res.published, 1);
  const d1 = await itemNaFila("D1");
  assert.equal(d1.status, "PUBLISHED");
  assert.equal(d1.metadata.shopifyProductId, "gid://shopify/Product/42");
  assert.equal(d1.metadata.alertaPublicadoNaShopify, undefined);
});

await check("(d) erro sem decisão humana continua a gravar SYNC_ERROR", async () => {
  escreverFila([item("D2")]);
  const publicar = async () => {
    throw new Error("Produto recusado pela Shopify (teste)");
  };
  await engine.runApprovedShopifySync(SESSAO, { dependencias: dependencias(publicar) });
  const d2 = await itemNaFila("D2");
  assert.equal(d2.status, "SYNC_ERROR");
  assert.match(d2.metadata.syncError, /recusado pela Shopify/);
});

console.log("Leitura do estado antes de criar");

await check("(e) lerEstadoAtualNaFila lê o disco, mesmo com a cache de memória antiga", async () => {
  escreverFila([item("E1", "APPROVED")]);
  await q.loadCurationQueue();
  // Outro processo muda o ficheiro sem passar por esta cache.
  const doDisco = JSON.parse(fs.readFileSync(QUEUE, "utf8"));
  doDisco.items[0].status = "REJECTED";
  fs.writeFileSync(QUEUE, JSON.stringify(doDisco), "utf8");
  assert.equal(await q.lerEstadoAtualNaFila("E1"), "REJECTED");
  assert.equal(await q.lerEstadoAtualNaFila("NAO-EXISTE"), null);
});

console.log("Alerta visível depois da criação");

await check("(f) o alerta sobrevive ao ciclo do worker num item rejeitado por regra (não humano)", async () => {
  const alerta = { shopifyProductId: "gid://shopify/Product/7", em: "2026-10-16T10:00:00.000Z" };
  escreverFila([
    {
      sku: "F1",
      title_en: "F1",
      status: "REJECTED",
      reason: "regra",
      shopifyStatus: "DRAFT",
      statusChangedAt: "2026-01-01T00:00:00.000Z",
      metadata: { origem: "regra", alertaPublicadoNaShopify: alerta },
    },
  ]);
  await q.upsertCurationQueueFromRecord({
    sku: "F1",
    title: "F1",
    _source: { title: "F1" },
    netPrice: 10,
    grossPrice: 12,
    availableQuantity: 3,
    vendor: "V",
    categoryMain: "C",
  });
  assert.deepEqual((await itemNaFila("F1")).metadata.alertaPublicadoNaShopify, alerta);
});

await check("(h) o alerta sobrevive à escrita do worker (flush) num item rejeitado por regra", async () => {
  const alerta = { shopifyProductId: "gid://shopify/Product/8", em: "2026-10-16T11:00:00.000Z" };
  escreverFila([
    {
      sku: "H1",
      title_en: "H1",
      status: "REJECTED",
      reason: "regra",
      shopifyStatus: "DRAFT",
      statusChangedAt: "2026-01-01T00:00:00.000Z",
      metadata: { origem: "regra", alertaPublicadoNaShopify: alerta },
    },
  ]);
  // Leitura do worker antes da decisão (statusChangedAt anterior a readAt): o item não está protegido.
  const readAt = Date.parse("2026-10-01T00:00:00.000Z");
  await q.flushCurationQueueItems(
    [{ sku: "H1", title_en: "H1", status: "REJECTED", reason: "regra", shopifyStatus: "DRAFT", metadata: { origem: "regra" } }],
    { readAt }
  );
  assert.deepEqual((await itemNaFila("H1")).metadata.alertaPublicadoNaShopify, alerta);
});

await check("(g) painel: a linha mostra 'Publicado na Shopify' com o alerta vindo da fila", () => {
  const painel = fs.readFileSync(path.join(ROOT, "app/routes/app._index.jsx"), "utf8");
  const linhas = fs.readFileSync(path.join(ROOT, "lib/importer/catalog/catalogProductsDb.server.js"), "utf8");
  assert.match(linhas, /publicadoNaShopifyAlerta: queueEntries\.get\(p\.sku\)\?\.metadata\?\.alertaPublicadoNaShopify/);
  assert.match(painel, /publicadoNaShopifyAlerta,/);
  assert.match(painel, /\{publicadoNaShopifyAlerta && \(/);
  assert.match(painel, /<Badge tone="critical">Publicado na Shopify<\/Badge>/);
});

fs.rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nshopify-publish-human-decision: todos os casos passaram");
