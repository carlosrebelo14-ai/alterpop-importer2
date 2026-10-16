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
 *   (e) a leitura antes de criar é do disco, não da cache em memória;
 *   (g) o alerta 'Publicado na Shopify' depende só de haver alerta registado (função pura do painel);
 *   (i) lock ocupado na releitura (caminho normal e nova tentativa): a corrida aborta, o item fica APPROVED
 *       e não grava SYNC_ERROR (Decisão 30);
 *   (k) PENDING e SYNC_ERROR não são publicados: no arranque, durante a corrida e antes da marcação.
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

await check("(g) painel: a linha mostra 'Publicado na Shopify' só quando há alerta registado", async () => {
  const { mostrarAlertaPublicado } = await import(path.join(ROOT, "lib/curation/alertaPublicado.js"));
  const alerta = { shopifyProductId: "gid://shopify/Product/9", em: "2026-10-16T12:00:00.000Z" };
  assert.equal(mostrarAlertaPublicado({ status: "REJECTED", publicadoNaShopifyAlerta: alerta }), true, "alerta presente com REJECTED mostra o alerta");
  assert.equal(mostrarAlertaPublicado({ status: "REJECTED", publicadoNaShopifyAlerta: null }), false, "sem alerta não mostra");
  assert.equal(mostrarAlertaPublicado({ status: "REJECTED" }), false, "linha sem o campo não mostra");
  assert.equal(mostrarAlertaPublicado(null), false, "linha ausente não mostra");
  // Ligação: a linha do painel recebe o alerta da fila, e a rota chama a função (não repete a condição).
  const linhas = fs.readFileSync(path.join(ROOT, "lib/importer/catalog/catalogProductsDb.server.js"), "utf8");
  const painel = fs.readFileSync(path.join(ROOT, "app/routes/app._index.jsx"), "utf8");
  assert.match(linhas, /publicadoNaShopifyAlerta: queueEntries\.get\(p\.sku\)\?\.metadata\?\.alertaPublicadoNaShopify/);
  assert.match(painel, /\{mostrarAlertaPublicado\(item\) && \(/);
});

console.log("Leitura com lock ocupado (Decisão 30)");

// A releitura espera PRAZO_LOCK_MS e falha. O lock só é libertado depois (LIBERTA_LOCK_MS), a tempo de
// uma escrita de SYNC_ERROR que a versão errada tentaria logo a seguir. Sem a libertação, essa escrita
// também falharia e o teste não distinguiria as duas versões.
const PRAZO_LOCK_MS = 500;
const LIBERTA_LOCK_MS = 800;
let timerDoLock = null;

/** Ocupa o lock de ficheiro da fila com um titular vivo e fresco (este próprio processo). Liberta-o ao fim de libertaEmMs. */
function ocuparLock(libertaEmMs) {
  const lockFile = path.join(tmp, "curation-queue.lock");
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, em: new Date().toISOString(), token: "lock-ocupado-teste" }), "utf8");
  clearTimeout(timerDoLock);
  timerDoLock = setTimeout(() => fs.rmSync(lockFile, { force: true }), libertaEmMs);
}

/** Corre fn com o prazo de lock curto e repõe o ambiente, o timer e o lock no fim. */
async function comPrazoDeLockCurto(fn) {
  const anterior = process.env.CURATION_QUEUE_LOCK_PRAZO_MS;
  process.env.CURATION_QUEUE_LOCK_PRAZO_MS = String(PRAZO_LOCK_MS);
  try {
    return await fn();
  } finally {
    if (anterior === undefined) delete process.env.CURATION_QUEUE_LOCK_PRAZO_MS;
    else process.env.CURATION_QUEUE_LOCK_PRAZO_MS = anterior;
    clearTimeout(timerDoLock);
    timerDoLock = null;
    fs.rmSync(path.join(tmp, "curation-queue.lock"), { force: true });
  }
}

await check("(i) lock ocupado na releitura antes de criar: a corrida aborta com erro, o item fica APPROVED sem SYNC_ERROR", async () => {
  escreverFila([item("L1")]);
  const criados = [];
  const publicar = async (_client, row) => {
    criados.push(row.sku);
    return { shopifyProductId: `gid://shopify/Product/${row.sku}` };
  };
  // O lock é ocupado depois de a corrida ler o catálogo e antes do primeiro ciclo: é aí que se relê o estado.
  const deps = {
    ...dependencias(publicar),
    garantirMetafields: async () => {
      ocuparLock(LIBERTA_LOCK_MS);
      return false;
    },
  };
  await comPrazoDeLockCurto(async () => {
    await assert.rejects(engine.runApprovedShopifySync(SESSAO, { dependencias: deps }), /fila de curadoria ocupada/, "a corrida tem de devolver o erro da releitura");
  });
  assert.deepEqual(criados, [], "sem releitura não há criação de produto");
  const l1 = await itemNaFila("L1");
  assert.equal(l1.status, "APPROVED", "o item fica APPROVED");
  assert.equal(l1.metadata.syncError ?? null, null, "a releitura não grava SYNC_ERROR");
});

await check("(i2) lock ocupado na releitura de uma nova tentativa: a corrida aborta, o item fica APPROVED sem SYNC_ERROR", async () => {
  escreverFila([item("L2")]);
  const chamadas = [];
  const publicar = async (_client, row) => {
    chamadas.push(row.sku);
    // Sessão inválida na primeira criação, e o lock fica ocupado antes da nova tentativa.
    ocuparLock(LIBERTA_LOCK_MS);
    throw new Error("401 Unauthorized (teste)");
  };
  await comPrazoDeLockCurto(async () => {
    await assert.rejects(engine.runApprovedShopifySync(SESSAO, { dependencias: dependencias(publicar) }), /fila de curadoria ocupada/, "a corrida tem de devolver o erro da releitura");
  });
  assert.deepEqual(chamadas, ["L2"], "a nova tentativa não chega a criar produto");
  const l2 = await itemNaFila("L2");
  assert.equal(l2.status, "APPROVED", "o item fica APPROVED");
  assert.equal(l2.metadata.syncError ?? null, null, "a releitura da nova tentativa não grava SYNC_ERROR");
});

console.log("Estado do item durante a corrida: PENDING e SYNC_ERROR (Decisão 2 e 30)");

await check("(k0) PENDING e SYNC_ERROR no arranque não entram na corrida e não são publicados", async () => {
  escreverFila([item("KP", "PENDING"), item("KE", "SYNC_ERROR"), item("KA")]);
  const criados = [];
  const publicar = async (_client, row) => {
    criados.push(row.sku);
    return { shopifyProductId: `gid://shopify/Product/${row.sku}` };
  };
  const res = await engine.runApprovedShopifySync(SESSAO, { dependencias: dependencias(publicar) });
  assert.equal(res.ok, true);
  assert.deepEqual(criados, ["KA"], "só o APPROVED é publicado");
  assert.equal((await itemNaFila("KP")).status, "PENDING");
  assert.equal((await itemNaFila("KE")).status, "SYNC_ERROR");
});

await check("(k1) PENDING durante a corrida: a releitura salta o SKU e não o cria na Shopify", async () => {
  escreverFila([item("K0"), item("K1")]);
  const criados = [];
  const publicar = async (_client, row) => {
    criados.push(row.sku);
    if (row.sku === "K0") {
      // Uma desaprovação durante a corrida volta K1 a PENDING antes da releitura dele.
      await q.mutateCurationQueue((fila) => {
        fila.items.find((i) => i.sku === "K1").status = "PENDING";
        return { gravar: true, valor: null };
      });
    }
    return { shopifyProductId: `gid://shopify/Product/${row.sku}` };
  };
  const res = await engine.runApprovedShopifySync(SESSAO, { dependencias: dependencias(publicar) });
  assert.deepEqual(criados, ["K0"], "K1 em PENDING na releitura não pode ser criado na Shopify");
  assert.equal(res.saltados, 1, "K1 conta como saltado");
  assert.equal((await itemNaFila("K1")).status, "PENDING");
});

await check("(k2) SYNC_ERROR durante a publicação: o produto criado não marca o item PUBLISHED sem nova aprovação", async () => {
  escreverFila([item("S1")]);
  const publicar = async (_client, row) => {
    // Erro de sincronização gravado depois da releitura e antes da marcação de PUBLISHED.
    await q.markQueueItemSyncError(row.sku, "erro concorrente (teste)");
    return { shopifyProductId: `gid://shopify/Product/${row.sku}` };
  };
  await engine.runApprovedShopifySync(SESSAO, { dependencias: dependencias(publicar) });
  const s1 = await itemNaFila("S1");
  assert.equal(s1.status, "SYNC_ERROR", "sem nova aprovação o item fica SYNC_ERROR");
  assert.notEqual(s1.status, "PUBLISHED");
});

fs.rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nshopify-publish-human-decision: todos os casos passaram");
