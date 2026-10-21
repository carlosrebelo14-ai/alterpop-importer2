#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-30 e DBG-72 (PR 7, ronda 4). Testa o laço de apagamento do reset com a Shopify simulada (fetch falso) e a fila
 * num diretório temporário. Não chama a Shopify nem a BD de produção.
 *
 *   T1 a T8: o harness de docs/planos/plano-2b.md (linha ~206), com as correções 2.7 e 2.8 e as decisões D35 a D44.
 *   D2 (DBG-72): decisão humana depois do arranque ganha ao apagamento.
 *   Retomada (D39): reset morto (sem batimento há mais de 10 min) retoma-se sem contar outra vez o que já foi apagado.
 *   Verificação final: zero produtos na loja e zero PUBLISHED na fila, senão o reset não fica concluído.
 *   Dry-run: conta, não escreve. Reserva da publicação dentro do motor. Recusa com script vivo (mensagem).
 *   D2 na retoma: o instante do primeiro arranque passa de uma retoma para a outra, e a publicação na pausa não conta.
 *   D39: o batimento renova-se enquanto o processo vive. Arranque com trinco entre processos.
 *   CLI de libertação: o batimento decide, e a trava de idade recusa um valor não numérico.
 *   D42: o ciclo salta a publicação com reset em curso, e regista o salto (verificação estática).
 *   Mutações: cada correção tem uma troca que tem de deixar um caso vermelho (cópia do módulo no mesmo diretório).
 *
 * Uso: node scripts/tests/shopify-reset-loop.test.js
 */
import "./_isolate-curation.js";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "reset-loop-root-"));
fs.mkdirSync(path.join(projectRoot, "config"), { recursive: true });
fs.mkdirSync(path.join(projectRoot, "server", "data"), { recursive: true });
fs.copyFileSync(path.join(REPO, "config", "curation.json"), path.join(projectRoot, "config", "curation.json"));
fs.copyFileSync(path.join(REPO, "server", "data", "taxonomy-map.json"), path.join(projectRoot, "server", "data", "taxonomy-map.json"));
process.env.PROJECT_ROOT = projectRoot;
process.env.SHOPIFY_SHOP_URL = "loja-teste.myshopify.com";
process.env.SHOPIFY_ACCESS_TOKEN = "token-de-teste";
process.env.SHOPIFY_GRAPHQL_MIN_MS = "0";
// DBG-180: tempo limite curto para o reset, para o caso de um pedido pendurado correr em milissegundos.
process.env.SHOPIFY_RESET_TEMPO_LIMITE_MS = "80";
process.on("exit", () => fs.rmSync(projectRoot, { recursive: true, force: true }));

const modulo = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);
const q = await modulo("lib/curation/curationQueue.server.js");
const cfg = await modulo("lib/importer/config.js");
const dbd = await modulo("lib/health/dbDegraded.js");
const pem = await modulo("lib/importer/shopify/publicacaoEmCurso.js");
const atv = await modulo("lib/curation/atividadeApp.js");
const job = await modulo("lib/importer/shopify/shopifyResetJob.server.js");
const reset = await modulo("lib/importer/shopify/shopifyReset.server.js");

const SHOP = "loja-teste.myshopify.com";
const session = { shop: SHOP, accessToken: "token-de-teste" };
const DECIDIDO = "2026-10-01T10:00:00.000Z";
const gid = (n) => `gid://shopify/Product/${n}`;
const ESTADO_DIR = path.join(cfg.getDefaultConfig().paths.data, "shopify-reset");

// ── Shopify simulada ─────────────────────────────────────────────────────────
const loja = {
  produtos: new Map(),
  apagar: [],
  listagens: [],
  erro: new Set(),
  auth: new Set(),
  naoApaga: new Set(),
  paginas: null,
  paginaSemProducts: null,
  aoApagarPrimeiro: null,
  contagemForcada: null,
  contagemSemCampo: false,
  erroEJaSaiu: new Set(),
  pendurar: new Set(),
};

function reiniciarLoja(produtos) {
  loja.produtos = new Map(produtos.map(([n, sku]) => [gid(n), { id: gid(n), title: `P${n}`, sku }]));
  loja.apagar = [];
  loja.listagens = [];
  loja.erro = new Set();
  loja.auth = new Set();
  loja.naoApaga = new Set();
  loja.paginas = null;
  loja.paginaSemProducts = null;
  loja.aoApagarPrimeiro = null;
  loja.contagemForcada = null;
  loja.contagemSemCampo = false;
  loja.erroEJaSaiu = new Set();
  loja.pendurar = new Set();
}

function resposta(status, corpo) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => JSON.parse(corpo),
    text: async () => corpo,
  };
}

function nodeDoProduto(p) {
  return { id: p.id, title: p.title, tags: [], variants: { nodes: p.sku ? [{ sku: p.sku }] : [] } };
}

/**
 * Um pedido que não responde: só sai por cancelamento. A rede de segurança de 2 s faz a mutação falhar com erro comum
 * (e não pendurar a suíte) se o cliente não tiver tempo limite.
 */
function pendurado(init) {
  return new Promise((_resolve, rejeita) => {
    const seguranca = setTimeout(() => rejeita(new Error("pedido pendurado sem tempo limite")), 2000);
    init.signal?.addEventListener("abort", () => {
      clearTimeout(seguranca);
      rejeita(init.signal.reason);
    });
  });
}

globalThis.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  if (query.includes("productDelete(input")) {
    const id = variables.input.id;
    loja.apagar.push(id);
    if (loja.pendurar.has(id)) return pendurado(init);
    if (loja.aoApagarPrimeiro && loja.apagar.length === 1) loja.aoApagarPrimeiro();
    if (loja.auth.has(id)) {
      return resposta(401, JSON.stringify({ errors: "[API] Invalid API key or access token" }));
    }
    if (loja.erro.has(id)) {
      // «Product not found» com o produto já fora da loja: o erro chega, e a loja fica sem o produto.
      if (loja.erroEJaSaiu.has(id)) loja.produtos.delete(id);
      return resposta(200, JSON.stringify({ data: { productDelete: { deletedProductId: null, userErrors: [{ field: ["id"], message: "Product not found" }] } } }));
    }
    if (!loja.naoApaga.has(id)) loja.produtos.delete(id);
    return resposta(200, JSON.stringify({ data: { productDelete: { deletedProductId: id, userErrors: [] } } }));
  }
  if (query.includes("productsCount")) {
    if (loja.contagemSemCampo) return resposta(200, JSON.stringify({ data: {} }));
    const count = loja.contagemForcada ?? loja.produtos.size;
    return resposta(200, JSON.stringify({ data: { productsCount: { count } } }));
  }
  if (query.includes("AllShopProducts")) {
    const after = variables.after ?? null;
    loja.listagens.push(after);
    const idx = after ? Number(String(after).slice(1)) : 0;
    if (loja.paginaSemProducts === idx) {
      return resposta(200, JSON.stringify({ data: {} }));
    }
    let nodes;
    let hasNext = false;
    if (loja.paginas) {
      nodes = (loja.paginas[idx] || []).map((id) => loja.produtos.get(id)).filter(Boolean);
      hasNext = idx < loja.paginas.length - 1;
    } else {
      nodes = [...loja.produtos.values()];
    }
    const data = {
      products: {
        nodes: nodes.map(nodeDoProduto),
        pageInfo: { hasNextPage: hasNext, endCursor: hasNext ? `c${idx + 1}` : null },
      },
    };
    return resposta(200, JSON.stringify({ data }));
  }
  throw new Error(`query não prevista no teste: ${String(query).slice(0, 60)}`);
};

// ── Estado e fila ────────────────────────────────────────────────────────────
function limparEstado() {
  fs.rmSync(ESTADO_DIR, { recursive: true, force: true });
}

function escreverEstado(estado) {
  fs.mkdirSync(ESTADO_DIR, { recursive: true });
  fs.writeFileSync(path.join(ESTADO_DIR, `${SHOP.replace(/\//g, "_")}-status.json`), JSON.stringify(estado));
}

function escreverFila(items) {
  fs.writeFileSync(
    path.join(process.env.CURATION_DATA_DIR, "curation-queue.json"),
    JSON.stringify({ version: 1, updatedAt: null, items })
  );
  q.invalidateCurationMemoryCache();
}

async function filaAtual() {
  q.invalidateCurationMemoryCache();
  return (await q.loadCurationQueue()).items;
}

/** Item da fila. `pid` é o número do produto Shopify (gid), ou null. */
function item(sku, status, pid = null, statusChangedAt = DECIDIDO) {
  return {
    sku,
    title_en: `Produto ${sku}`,
    status,
    reason: "manual_dashboard",
    shopifyStatus: pid ? "ACTIVE" : "DRAFT",
    statusChangedAt,
    metadata: {
      origem: "humano",
      shopifyProductId: pid ? gid(pid) : null,
      publishedAt: pid ? DECIDIDO : null,
      approvedAt: DECIDIDO,
      rejectedAt: null,
    },
  };
}

async function estadoDoReset(m) {
  return (await m.readShopifyResetStatus(SHOP)) ?? null;
}

/** Corre o reset com o módulo dado. Devolve o resultado, o erro e o estado final do job. */
async function correr(m, opcoes = {}) {
  loja.apagar.length = 0;
  let resultado = null;
  let erro = null;
  try {
    resultado = await m.runShopifyCatalogReset(session, opcoes);
  } catch (err) {
    erro = err;
  }
  return { resultado, erro, estado: await estadoDoReset(job), fila: await filaAtual() };
}

/** Módulo com uma troca de texto (mutação). A cópia fica no mesmo diretório, para os imports relativos. */
async function moduloMutado(ficheiro, nome, antigo, novo) {
  const origem = path.join(REPO, ficheiro);
  const texto = fs.readFileSync(origem, "utf8");
  const vezes = texto.split(antigo).length - 1;
  if (vezes !== 1) throw new Error(`mutação ${nome}: a âncora tem de existir uma vez (existe ${vezes}x)`);
  const destino = path.join(path.dirname(origem), `.mutante-${nome}-${process.pid}${path.extname(origem)}`);
  fs.writeFileSync(destino, texto.replace(antigo, () => novo));
  try {
    return await import(pathToFileURL(destino).href);
  } finally {
    fs.rmSync(destino, { force: true });
  }
}

const SHOPIFY_RESET = "lib/importer/shopify/shopifyReset.server.js";
const SHOPIFY_JOB = "lib/importer/shopify/shopifyResetJob.server.js";

// ── Cenários ────────────────────────────────────────────────────────────────
// Cada cenário arranca a loja, a fila e o estado, corre o reset e devolve o resultado. As verificações são à parte,
// para que as mutações possam correr o mesmo cenário e tenham de falhar nas mesmas verificações.

async function cenarioT1(m) {
  reiniciarLoja([[1, "S1"], [2, "S2"], [3, "S3"]]);
  limparEstado();
  escreverFila([item("S1", "PUBLISHED", 1), item("S2", "PUBLISHED", 2), item("S3", "PUBLISHED", 3)]);
  return correr(m, {});
}
function verificarT1(r) {
  assert.equal(r.erro, null, r.erro?.message);
  assert.equal(r.estado.state, "completed");
  assert.equal(r.estado.deleted, 3);
  assert.deepEqual(loja.apagar, [gid(1), gid(2), gid(3)]);
  assert.ok(r.fila.every((i) => i.status === "PENDING" && i.metadata.origem === "reset"), "a fila tem de ficar PENDING");
}

async function cenarioT2(m) {
  reiniciarLoja([[1, "S1"], [2, "S2"], [3, "S3"]]);
  loja.erro.add(gid(2));
  limparEstado();
  escreverFila([item("S1", "PUBLISHED", 1), item("S2", "PUBLISHED", 2), item("S3", "PUBLISHED", 3)]);
  return correr(m, {});
}
function verificarT2(r) {
  assert.equal(r.estado.state, "failed", "com uma falha no produto 2, a loja não fica vazia: a verificação final tem de falhar");
  assert.match(r.estado.error, /Verificação final/);
  assert.equal(r.estado.failed, 1);
  assert.equal(r.estado.deleted, 2);
  assert.ok(r.estado.recentErrors.some((e) => e.productId === gid(2)), "o produto 2 tem de estar em recentErrors");
  const s2 = r.fila.find((i) => i.sku === "S2");
  assert.equal(s2.status, "PUBLISHED", "o apagamento falhado fica PUBLISHED, com o vínculo");
  assert.equal(r.fila.find((i) => i.sku === "S1").status, "PENDING");
}

async function cenarioT2b(m) {
  reiniciarLoja([[1, "S1"], [2, null], [3, "S3"]]);
  loja.erro.add(gid(2));
  limparEstado();
  escreverFila([item("S1", "PUBLISHED", 1), item("S2", "PUBLISHED", 2), item("S3", "PUBLISHED", 3)]);
  return correr(m, {});
}
function verificarT2b(r) {
  const s2 = r.fila.find((i) => i.sku === "S2");
  assert.equal(s2.status, "PUBLISHED", "sem SKU no produto, o id decide: o item do produto 2 não pode voltar a PENDING");
}

async function cenarioT3(m) {
  reiniciarLoja([[1, "S1"], [2, "S2"], [3, "S3"]]);
  loja.auth.add(gid(2));
  limparEstado();
  escreverFila([item("S1", "PUBLISHED", 1), item("S2", "PUBLISHED", 2), item("S3", "PUBLISHED", 3)]);
  return correr(m, {});
}
function verificarT3(r) {
  assert.equal(r.estado.state, "failed");
  assert.match(r.estado.error, /Reabre a app/, "o aviso de auth tem de dizer que se reabre a app");
  assert.ok(r.estado.recentErrors.some((e) => e.productId === gid(2)), "o erro do produto que aborta tem de ficar no estado");
  assert.deepEqual(loja.apagar, [gid(1), gid(2)], "o reset aborta no produto 2: o produto 3 não é tentado");
}

async function cenarioT4(m) {
  reiniciarLoja([]);
  limparEstado();
  escreverFila([item("S1", "PUBLISHED", 9)]);
  return correr(m, {});
}
function verificarT4(r) {
  assert.equal(r.erro, null, r.erro?.message);
  assert.equal(r.estado.state, "completed");
  assert.equal(r.fila[0].status, "PENDING", "loja vazia confirmada: a varredura fecha o PUBLISHED");
}

async function cenarioT4b(m) {
  reiniciarLoja([]);
  loja.contagemForcada = 2;
  limparEstado();
  escreverFila([item("S1", "PUBLISHED", 9)]);
  return correr(m, {});
}
function verificarT4b(r) {
  assert.equal(r.estado.state, "failed", "a segunda leitura não bate: o reset para");
  assert.match(r.estado.error, /contagem da loja deu 2/);
  assert.equal(r.fila[0].status, "PUBLISHED", "sem a segunda leitura a zero, a varredura não corre");
}

async function cenarioT5(m) {
  reiniciarLoja([[1, "S1"], [2, "S2"], [3, "S3"]]);
  loja.paginas = [[gid(1)], [gid(2), gid(3)]];
  loja.paginaSemProducts = 1;
  limparEstado();
  escreverFila([item("S1", "PUBLISHED", 1), item("S2", "PUBLISHED", 2), item("S3", "PUBLISHED", 3)]);
  return correr(m, {});
}
function verificarT5(r) {
  assert.equal(r.estado.state, "failed");
  assert.match(r.estado.error, /sem products ou pageInfo/);
  assert.equal(loja.apagar.length, 0, "uma lista parcial não pode apagar nada");
}

async function cenarioT6(m) {
  reiniciarLoja([[1, "S1"], [2, "S2"], [3, "S3"]]);
  loja.aoApagarPrimeiro = () => dbd.markDbDegraded("teste do PR 7 (T6)");
  limparEstado();
  escreverFila([item("S1", "PUBLISHED", 1), item("S2", "PUBLISHED", 2), item("S3", "PUBLISHED", 3)]);
  try {
    return await correr(m, {});
  } finally {
    dbd.clearDbDegraded();
  }
}
function verificarT6(r) {
  assert.equal(r.estado.state, "failed");
  assert.match(r.estado.error, /D35/, "a primeira falha de gravação local para o reset");
  assert.equal(loja.apagar.length, 1, "um único apagamento antes de parar");
  assert.equal(r.estado.deleted, 1, "o apagado conta-se já, antes da gravação local");
}

async function cenarioT6b(m) {
  reiniciarLoja([[1, "S1"], [2, "S2"]]);
  limparEstado();
  escreverFila([item("S1", "PUBLISHED", 1), item("S2", "PUBLISHED", 2)]);
  dbd.markDbDegraded("teste do PR 7 (T6b, D36)");
  try {
    return await correr(m, {});
  } finally {
    dbd.clearDbDegraded();
  }
}
function verificarT6b(r) {
  assert.equal(r.estado.state, "failed");
  assert.match(r.estado.error, /modo degradado/);
  assert.equal(loja.apagar.length, 0, "com a BD degradada, nenhum produto é apagado (D36)");
}

async function cenarioT8(m) {
  reiniciarLoja([[1, "S1"], [2, "S2"]]);
  loja.paginas = [[gid(1)], [gid(2)]];
  limparEstado();
  escreverFila([item("S1", "PUBLISHED", 1), item("S2", "PUBLISHED", 2)]);
  return correr(m, {});
}
function verificarT8(r) {
  assert.equal(r.estado.state, "completed");
  assert.equal(r.estado.deleted, 2);
  assert.deepEqual(loja.listagens, [null, "c1"], "duas páginas, a segunda com o cursor da primeira");
}

async function cenarioD38(m) {
  reiniciarLoja([[1, "S1"], [2, "S2"], [3, "S3"], [4, "S4"], [5, "S5"]]);
  for (const n of [1, 2, 3, 4, 5]) loja.erro.add(gid(n));
  limparEstado();
  escreverFila([1, 2, 3, 4, 5].map((n) => item(`S${n}`, "PUBLISHED", n)));
  return correr(m, {});
}
function verificarD38(r) {
  assert.equal(r.estado.state, "failed");
  assert.match(r.estado.error, /3 falhas seguidas/);
  assert.equal(loja.apagar.length, 3, "três falhas seguidas param o reset: o produto 4 não é tentado");
}

async function cenarioD2(m) {
  reiniciarLoja([[1, "S1"], [2, "S2"]]);
  limparEstado();
  const humana = new Date(Date.now() + 60_000).toISOString();
  escreverFila([
    { ...item("S1", "APPROVED", 1, humana) },
    item("S2", "PUBLISHED", 2),
  ]);
  return correr(m, {});
}
function verificarD2(r) {
  assert.equal(r.estado.state, "completed", r.estado.error);
  const s1 = r.fila.find((i) => i.sku === "S1");
  assert.equal(s1.status, "APPROVED", "uma decisão humana depois do arranque não pode ser reescrita pelo apagamento (D2)");
  assert.equal(r.fila.find((i) => i.sku === "S2").status, "PENDING");
}

async function cenarioD39Vivo(m) {
  reiniciarLoja([[1, "S1"]]);
  limparEstado();
  escreverEstado({ jobId: "vivo", state: "deleting", deleted: 0, updatedAt: new Date().toISOString(), startedAt: new Date().toISOString() });
  escreverFila([item("S1", "PUBLISHED", 1)]);
  return correr(m, {});
}
function verificarD39Vivo(r) {
  assert.match(String(r.erro?.message), /Já existe um reset Shopify em curso/, "um reset com batimento recente recusa-se");
  assert.equal(loja.apagar.length, 0);
}

async function cenarioRetoma(m) {
  reiniciarLoja([[3, "S3"]]);
  limparEstado();
  const antes = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  escreverEstado({ jobId: "shopify-reset-antigo", state: "deleting", deleted: 2, revertedLocal: 2, updatedAt: antes, startedAt: antes });
  escreverFila([item("S1", "PENDING"), item("S2", "PENDING"), item("S3", "PUBLISHED", 3)]);
  return correr(m, {});
}
function verificarRetoma(r) {
  assert.equal(r.erro, null, r.erro?.message);
  assert.equal(r.estado.state, "completed");
  assert.equal(r.estado.deleted, 3, "o apagado do reset morto conta-se uma vez: 2 antes, 1 agora");
  assert.equal(r.estado.revertedLocal, 3, "o revertido localmente também: 2 antes, 1 agora");
  assert.deepEqual(loja.apagar, [gid(3)], "os produtos já apagados não são pedidos outra vez");
  assert.equal(r.estado.retomadoDe, "shopify-reset-antigo");
}

/** Retoma com decisão humana entre o arranque original (60 min) e o batimento morto (55 min): a decisão (30 min) ganha. */
async function cenarioRetomaComDecisao(m) {
  reiniciarLoja([[1, "S1"]]);
  limparEstado();
  const arranque = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const batimento = new Date(Date.now() - 55 * 60 * 1000).toISOString();
  escreverEstado({ jobId: "shopify-reset-antigo", state: "deleting", deleted: 0, revertedLocal: 0, updatedAt: batimento, startedAt: arranque });
  escreverFila([item("S1", "APPROVED", 1, new Date(Date.now() - 30 * 60 * 1000).toISOString())]);
  return correr(m, {});
}
function verificarRetomaComDecisao(r) {
  assert.equal(r.erro, null, r.erro?.message);
  assert.equal(r.estado.state, "completed", r.estado.error);
  assert.equal(
    r.fila.find((i) => i.sku === "S1").status,
    "APPROVED",
    "decisão humana tomada durante a tentativa interrompida ganha ao apagamento (D2 desde o primeiro arranque)"
  );
}

/** Retoma com uma publicação feita durante a pausa: o produto foi apagado, e o item não é decisão humana. */
async function cenarioRetomaComPublicacaoNaPausa(m) {
  reiniciarLoja([[1, "S1"], [2, "S2"]]);
  limparEstado();
  const arranque = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const batimento = new Date(Date.now() - 55 * 60 * 1000).toISOString();
  escreverEstado({ jobId: "shopify-reset-antigo", state: "deleting", deleted: 0, revertedLocal: 0, updatedAt: batimento, startedAt: arranque });
  escreverFila([item("S1", "PENDING"), item("S2", "PUBLISHED", 2, new Date(Date.now() - 30 * 60 * 1000).toISOString())]);
  return correr(m, {});
}
function verificarRetomaComPublicacaoNaPausa(r) {
  assert.equal(r.erro, null, r.erro?.message);
  assert.equal(r.estado.state, "completed", r.estado.error);
  const s2 = r.fila.find((i) => i.sku === "S2");
  assert.equal(s2.status, "PENDING", "uma publicação feita na pausa não é decisão humana: o produto foi apagado");
  assert.equal(s2.metadata.origem, "reset");
}

/** Retoma sem decisão: o instante do primeiro arranque passa de uma retoma para a seguinte (D2). */
async function cenarioRetomaDoArranque(m) {
  limparEstado();
  const primeiro = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const ultimo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  escreverEstado({ jobId: "retomado-antes", state: "deleting", deleted: 1, revertedLocal: 1, updatedAt: ultimo, startedAt: ultimo, inicioDoPrimeiroArranque: primeiro });
  return { retomado: await m.initShopifyResetJob(SHOP), primeiro, ultimo };
}
function verificarRetomaDoArranque({ retomado, primeiro, ultimo }) {
  assert.equal(retomado.inicioDoPrimeiroArranque, primeiro, "a retoma herda o primeiro arranque, e não o da retoma");
  assert.equal(retomado.retomadoDe, "retomado-antes");
  assert.notEqual(retomado.startedAt, ultimo, "o arranque da retoma é novo");
}

/** D39: o batimento renova-se enquanto o processo vive. Um reset com batimento antigo fica vivo. */
async function cenarioBatimento(m) {
  limparEstado();
  const antigo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  escreverEstado({ jobId: "sem-batimento", state: "deleting", deleted: 0, updatedAt: antigo, startedAt: antigo });
  const antes = m.resetEstaVivo(await m.readShopifyResetStatus(SHOP));
  const parar = m.iniciarBatimento(SHOP, 20);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await parar();
  const depois = await m.readShopifyResetStatus(SHOP);
  return { antes, depois, vivoDepois: m.resetEstaVivo(depois) };
}

/** Dois arranques no mesmo instante (purga e app). Com trinco, só um arranca. */
async function cenarioArranqueSimultaneo(m) {
  limparEstado();
  const agora = Date.now();
  return Promise.allSettled([m.initShopifyResetJob(SHOP, agora), m.initShopifyResetJob(SHOP, agora + 1)]);
}
function verificarArranqueSimultaneo(resultados) {
  const ok = resultados.filter((r) => r.status === "fulfilled");
  const recusadas = resultados.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1, "com trinco, a segunda chamada espera e vê o reset vivo");
  assert.match(String(recusadas[0]?.reason?.message), /Já existe um reset Shopify em curso/);
}

/** CLI de libertação: o batimento (não o arranque) decide. Corre o script como processo à parte. */
function correrLibertacao(argumentos) {
  return spawnSync(process.execPath, [path.join(REPO, "scripts", "catalog", "reset-lock-release.js"), ...argumentos], {
    encoding: "utf8",
    env: process.env,
  });
}
async function cenarioLibertacao(batimentoMinutos, argumentos) {
  limparEstado();
  const agora = Date.now();
  escreverEstado({
    jobId: "orfao",
    state: "deleting",
    deleted: 0,
    revertedLocal: 0,
    startedAt: new Date(agora - 40 * 60 * 1000).toISOString(),
    updatedAt: new Date(agora - batimentoMinutos * 60 * 1000).toISOString(),
  });
  const saida = correrLibertacao(argumentos);
  return { saida, estado: await job.readShopifyResetStatus(SHOP) };
}

/** DBG-180 no cliente: um pedido que não responde sai com ShopifyTimeoutError, sem esperar pela resposta. */
async function cenarioClienteTempoLimite(clienteModulo) {
  const original = globalThis.fetch;
  globalThis.fetch = (_url, init) =>
    new Promise((resolve, rejeita) => {
      const t = setTimeout(() => resolve(resposta(200, JSON.stringify({ data: { ok: true } }))), 300);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        rejeita(init.signal.reason);
      });
    });
  try {
    const cliente = new clienteModulo.ShopifyClient({ store: SHOP, accessToken: "token-de-teste", tempoLimiteMs: 50 });
    const inicio = Date.now();
    try {
      await cliente.graphqlRaw("query Ping { shop { name } }", {});
      return { erro: null, decorrido: Date.now() - inicio };
    } catch (err) {
      return { erro: err, decorrido: Date.now() - inicio };
    }
  } finally {
    globalThis.fetch = original;
  }
}
function verificarClienteTempoLimite({ erro, decorrido }) {
  assert.equal(erro?.code, "SHOPIFY_TIMEOUT", "o pedido sai com tempo limite, e não com resposta");
  assert.match(erro.message, /não respondeu em 50 ms/);
  assert.ok(decorrido < 250, `o tempo limite corta a espera (${decorrido} ms)`);
}

/** DBG-180 no reset: o apagamento que não responde para o reset como failed, sem contar como falha de produto. A
 * tentativa seguinte retoma-se (DBG-178) com o apagado da primeira. */
async function cenarioTempoLimiteNoApagamento(m) {
  reiniciarLoja([[1, "S1"], [2, "S2"]]);
  loja.pendurar.add(gid(2));
  limparEstado();
  escreverFila([item("S1", "PUBLISHED", 1), item("S2", "PUBLISHED", 2)]);
  const primeira = await correr(m, {});
  loja.pendurar.clear();
  const segunda = await correr(m, {});
  return { primeira, segunda };
}
function verificarTempoLimiteNoApagamento({ primeira, segunda }) {
  assert.equal(primeira.estado.state, "failed", primeira.estado.error);
  assert.match(primeira.estado.error, /Shopify não respondeu em 80 ms/);
  assert.equal(primeira.estado.deleted, 1, "o apagado antes do tempo limite conta-se");
  assert.equal(primeira.estado.failed, 0, "um pedido pendurado não é falha de produto");
  assert.equal(primeira.fila.find((i) => i.sku === "S2").status, "PUBLISHED", "o produto pendurado fica como estava");
  assert.equal(segunda.erro, null, segunda.erro?.message);
  assert.equal(segunda.estado.state, "completed", segunda.estado.error);
  assert.equal(segunda.estado.deleted, 2, "DBG-178: o apagado da tentativa falhada carrega-se na retoma");
  assert.equal(segunda.estado.retomadoDe, primeira.estado.jobId);
  assert.equal(segunda.fila.find((i) => i.sku === "S2").status, "PENDING");
}

/** DBG-178: a retoma de um reset falhado carrega o apagado e o revertido da tentativa anterior. */
async function cenarioRetomaDeFalhado(m) {
  limparEstado();
  const antigo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  escreverEstado({
    jobId: "falhado",
    state: "failed",
    deleted: 2,
    revertedLocal: 2,
    error: "três falhas seguidas",
    updatedAt: antigo,
    startedAt: antigo,
    finishedAt: antigo,
    inicioDoPrimeiroArranque: antigo,
  });
  return m.initShopifyResetJob(SHOP);
}
function verificarRetomaDeFalhado(retomado) {
  assert.equal(retomado.deleted, 2, "o apagado da tentativa falhada carrega-se");
  assert.equal(retomado.revertedLocal, 2, "o revertido também");
  assert.equal(retomado.retomadoDe, "falhado");
}

/** Estático (M16): o motor liga o batimento antes do trabalho e para-o no fim, em qualquer saída. */
function batimentoLigadoNoMotor(texto) {
  assert.match(texto, /const pararBatimento = iniciarBatimento\(shop\);/, "o reset liga o batimento");
  assert.match(texto, /\} finally \{\n    (await )?pararBatimento\(\);\n  \}/, "e para-o em qualquer saída");
}

/**
 * Cópia mutada de um script ou módulo, no mesmo diretório (imports relativos). A âncora tem de existir uma vez, e isto
 * corre fora de mutacaoTemDeFalhar: uma âncora errada é erro do teste, não mutação apanhada.
 */
function copiaMutada(ficheiro, nome, antigo, novo) {
  const origem = path.join(REPO, ficheiro);
  const texto = fs.readFileSync(origem, "utf8");
  const vezes = texto.split(antigo).length - 1;
  if (vezes !== 1) throw new Error(`mutação ${nome}: a âncora tem de existir uma vez (existe ${vezes}x)`);
  const destino = path.join(path.dirname(origem), `.mutante-${nome}-${process.pid}${path.extname(origem)}`);
  fs.writeFileSync(destino, texto.replace(antigo, () => novo));
  return destino;
}

/** A falha grava failed com a janela do D2 do primeiro arranque. A tentativa seguinte herda-a. */
async function cenarioFalhaDepoisDeDecisao(m) {
  reiniciarLoja([[1, "S1"]]);
  limparEstado();
  const primeiro = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const falha = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  escreverEstado({
    jobId: "shopify-reset-falhado",
    state: "failed",
    deleted: 0,
    revertedLocal: 0,
    error: "três falhas seguidas",
    updatedAt: falha,
    startedAt: falha,
    finishedAt: falha,
    inicioDoPrimeiroArranque: primeiro,
  });
  escreverFila([item("S1", "REJECTED", 1, new Date(Date.now() - 30 * 60 * 1000).toISOString())]);
  return correr(m, {});
}
function verificarFalhaDepoisDeDecisao(r) {
  assert.equal(r.erro, null, r.erro?.message);
  assert.equal(r.estado.state, "completed", r.estado.error);
  const s1 = r.fila.find((i) => i.sku === "S1");
  assert.equal(s1.status, "REJECTED", "decisão humana depois do primeiro arranque, numa tentativa falhada, ganha ao apagamento");
  assert.equal(s1.metadata.origem, "humano");
}

/** Um produto que aparece depois da listagem (outro processo publicou) não pode ser revertido pela varredura. */
async function cenarioPublicadoDuranteOReset(m) {
  reiniciarLoja([[1, "S1"]]);
  loja.aoApagarPrimeiro = () => loja.produtos.set(gid(9), { id: gid(9), title: "P9", sku: "S9" });
  limparEstado();
  escreverFila([item("S1", "PUBLISHED", 1), item("S9", "PUBLISHED", 9)]);
  return correr(m, {});
}
function verificarPublicadoDuranteOReset(r) {
  assert.equal(r.estado.state, "failed", r.estado.error);
  assert.match(r.estado.error, /produto\(s\) na loja/);
  const s9 = r.fila.find((i) => i.sku === "S9");
  assert.equal(s9.status, "PUBLISHED", "a loja ainda tem o produto: a fila não se toca");
  assert.equal(s9.metadata.shopifyProductId, gid(9));
}

/**
 * Apagamento falhado com «produto não encontrado» e a loja já vazia. O item fica PUBLISHED com o vínculo (2.8 (7)), e a
 * verificação final apanha-o. Com a loja vazia é o único caminho que chega à varredura, por isso é ele que prova as
 * exceções da varredura e o zero PUBLISHED.
 */
async function cenarioErroComLojaVazia(m) {
  reiniciarLoja([[1, "S1"], [2, "S2"]]);
  loja.erro.add(gid(2));
  loja.erroEJaSaiu.add(gid(2));
  limparEstado();
  escreverFila([item("S1", "PUBLISHED", 1), item("S2", "PUBLISHED", 2)]);
  return correr(m, {});
}
function verificarErroComLojaVazia(r) {
  assert.equal(r.estado.state, "failed", r.estado.error);
  const s2 = r.fila.find((i) => i.sku === "S2");
  assert.equal(s2.status, "PUBLISHED", "um apagamento falhado fica PUBLISHED com o vínculo, mesmo com a loja vazia");
  assert.equal(s2.metadata.shopifyProductId, gid(2));
}

/** Contagem sem o campo: não é zero. Com um produto que sobrevive, o reset não pode ficar concluído. */
async function cenarioContagemSemCampo(m) {
  reiniciarLoja([[1, "S1"], [2, "S2"]]);
  loja.naoApaga.add(gid(2));
  loja.contagemSemCampo = true;
  limparEstado();
  escreverFila([item("S1", "PUBLISHED", 1), item("S2", "PUBLISHED", 2)]);
  return correr(m, {});
}
function verificarContagemSemCampo(r) {
  assert.equal(r.estado.state, "failed", r.estado.error);
  assert.match(r.estado.error, /não devolveu a contagem/);
}

/** DBG-181: uma escrita sobre um estado que não se lê recusa-se. O ficheiro cortado fica como está. */
async function cenarioEscritaSobreIlegivel(m) {
  limparEstado();
  fs.mkdirSync(ESTADO_DIR, { recursive: true });
  const ficheiro = path.join(ESTADO_DIR, `${SHOP.replace(/\//g, "_")}-status.json`);
  const cortado = '{"jobId":"meio-escrito","state":"dele';
  fs.writeFileSync(ficheiro, cortado);
  let erro = null;
  try {
    await m.updateShopifyResetProgress(SHOP, { state: "deleting", deleted: 0 });
  } catch (err) {
    erro = err;
  }
  return { erro, conteudo: fs.readFileSync(ficheiro, "utf8"), cortado };
}
function verificarEscritaSobreIlegivel(r) {
  assert.match(String(r.erro?.message), /ilegível/, "a escrita recusa-se");
  assert.equal(r.conteudo, r.cortado, "o ficheiro fica como estava, para se decidir à mão");
}

/** CLI de libertação com o trinco de arranque tomado por outro processo. `copia` troca a CLI por uma cópia mutada. */
async function cenarioCliContraTrinco(copia = null) {
  limparEstado();
  const agora = Date.now();
  escreverEstado({
    jobId: "orfao",
    state: "deleting",
    deleted: 0,
    revertedLocal: 0,
    startedAt: new Date(agora - 40 * 60 * 1000).toISOString(),
    updatedAt: new Date(agora - 20 * 60 * 1000).toISOString(),
  });
  const trinco = await modulo("lib/curation/curationQueueFileLock.server.js");
  const titular = await trinco.adquirirLockDoFicheiro(job.caminhoDoTrincoDeArranque(SHOP), { prazoMs: 1000 });
  try {
    const script = copia ?? path.join(REPO, "scripts", "catalog", "reset-lock-release.js");
    const saida = spawnSync(process.execPath, [script, "--execute"], { encoding: "utf8", env: process.env, timeout: 60000 });
    return { saida, estado: await job.readShopifyResetStatus(SHOP) };
  } finally {
    await trinco.libertarLockDoFicheiro(titular);
  }
}

/** D2 depois de um reset concluído: o arranque seguinte abre uma janela nova e não herda a antiga. */
function cenarioCompletoNovaJanela() {
  limparEstado();
  const antigo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  escreverEstado({
    jobId: "concluido",
    state: "completed",
    deleted: 5,
    revertedLocal: 5,
    updatedAt: antigo,
    startedAt: antigo,
    finishedAt: antigo,
    inicioDoPrimeiroArranque: antigo,
  });
  return job.initShopifyResetJob(SHOP).then((retomado) => ({ retomado, antigo }));
}

async function cenarioVerificacao(m) {
  reiniciarLoja([[1, "S1"]]);
  loja.naoApaga.add(gid(1));
  limparEstado();
  escreverFila([item("S1", "PUBLISHED", 1)]);
  return correr(m, {});
}
function verificarVerificacao(r) {
  assert.equal(r.estado.state, "failed", "um produto que sobrevive ao apagamento não deixa o reset concluído");
  assert.match(r.estado.error, /Verificação final: 1 produto\(s\) na loja/);
}

async function cenarioReserva(m) {
  reiniciarLoja([[1, "S1"]]);
  limparEstado();
  escreverFila([item("S1", "PUBLISHED", 1)]);
  const reservaAlheia = pem.tentarReservarPublicacao();
  try {
    return await correr(m, {});
  } finally {
    reservaAlheia.libertar();
  }
}
function verificarReserva(r) {
  assert.match(String(r.erro?.message), /Já há uma publicação ou um reset Shopify em curso/, "o motor recusa-se com a reserva tomada");
  assert.equal(loja.apagar.length, 0, "sem reserva, nada é apagado");
}

async function cenarioDryRun(m) {
  reiniciarLoja([[1, "S1"], [2, "S2"], [3, "S3"]]);
  limparEstado();
  escreverFila([item("S1", "PUBLISHED", 1), item("S2", "PUBLISHED", 2), item("S3", "SYNC_ERROR", 3)]);
  return correr(m, { dryRun: true });
}
function verificarDryRun(r) {
  assert.equal(r.erro, null, r.erro?.message);
  assert.equal(r.resultado.produtosNaLoja, 3);
  assert.equal(r.resultado.entradasParaPending, 2);
  assert.equal(r.resultado.sincroErroPreservado, 1);
  assert.equal(loja.apagar.length, 0, "dry-run não apaga");
  assert.equal(r.fila.find((i) => i.sku === "S1").status, "PUBLISHED", "dry-run não escreve a fila");
  assert.equal(r.estado.state, "idle", "dry-run não escreve o estado do reset");
}

async function cenarioD44(m) {
  reiniciarLoja([[1, "S1"]]);
  limparEstado();
  escreverFila([item("S1", "PUBLISHED", 1), item("S2", "SYNC_ERROR", 2)]);
  return correr(m, {});
}
function verificarD44(r) {
  assert.equal(r.estado.state, "completed", r.estado.error);
  assert.equal(r.fila.find((i) => i.sku === "S2").status, "SYNC_ERROR", "SYNC_ERROR fica como está no reset (D44, D11)");
  assert.equal(r.resultado.sincroErroPreservado, 1, "e é listado no relatório");
}

// ── Execução ────────────────────────────────────────────────────────────────
let falhas = 0;
async function caso(nome, fn) {
  try {
    await fn();
    console.log(`  ok  ${nome}`);
  } catch (err) {
    falhas += 1;
    console.error(`FAIL  ${nome}\n      ${err.message}`);
  }
}

/** Uma mutação tem de fazer a verificação falhar. Se passar, a suíte não a apanha. */
async function mutacaoTemDeFalhar(nome, fn) {
  let apanhou = false;
  try {
    await fn();
  } catch {
    apanhou = true;
  }
  if (!apanhou) throw new Error(`mutação ${nome}: a suíte não a apanhou`);
}

console.log("shopify-reset-loop — laço do reset com Shopify simulada, fila temporária");

await caso("T1 baseline: 3 apagados, fila PENDING com origem reset, job completed", async () => verificarT1(await cenarioT1(reset)));
await caso("T2: falha no produto 2 → apagamento falhado fica PUBLISHED com o vínculo; verificação final falha", async () => verificarT2(await cenarioT2(reset)));
await caso("T2b: falha sem SKU → o id decide e o item do produto 2 fica PUBLISHED", async () => verificarT2b(await cenarioT2b(reset)));
await caso("T3: 401 no produto 2 → aviso 'Reabre a app', erro e produto 2 no estado, aborta sem tentar o produto 3", async () => verificarT3(await cenarioT3(reset)));
await caso("T4: loja vazia confirmada por segunda leitura → varredura fecha o PUBLISHED (D37)", async () => verificarT4(await cenarioT4(reset)));
await caso("T4b: listagem vazia mas contagem 2 → reset para, sem varredura (D37)", async () => verificarT4b(await cenarioT4b(reset)));
await caso("T5: página sem products nem pageInfo → lista parcial recusada, nada apagado (2.7 (4))", async () => verificarT5(await cenarioT5(reset)));
await caso("T6: BD degradada na primeira gravação local → para (D35); um apagamento", async () => verificarT6(await cenarioT6(reset)));
await caso("T6b: BD degradada antes do reset → nenhum apagamento (D36)", async () => verificarT6b(await cenarioT6b(reset)));
await caso("T7: revert com id: o id decide, o SKU repetido não poupa o item (2.8 (7))", async () => {
  reiniciarLoja([]);
  limparEstado();
  escreverFila([item("S-1", "PUBLISHED", 30), item("S-2", "PUBLISHED", 31)]);
  const revertidos = await reset.revertAllPublishedInQueue({
    deletedInAdmin: true,
    exceptSkus: ["S-1"],
    exceptIds: [gid(31)],
  });
  assert.equal(revertidos, 1, "só o item com id fora da exceção reverte");
  const fila = await filaAtual();
  assert.equal(fila.find((i) => i.sku === "S-1").status, "PENDING");
  assert.equal(fila.find((i) => i.sku === "S-2").status, "PUBLISHED");
});
await caso("T8: duas páginas de listagem, a segunda com o cursor da primeira", async () => verificarT8(await cenarioT8(reset)));
await caso("D38: três falhas seguidas param o reset", async () => verificarD38(await cenarioD38(reset)));
await caso("D2 (DBG-72): decisão humana depois do arranque não é reescrita pelo apagamento", async () => verificarD2(await cenarioD2(reset)));
await caso("D39: reset com batimento recente recusa-se, sem apagar", async () => verificarD39Vivo(await cenarioD39Vivo(reset)));
await caso("D39: reset morto (batimento antigo) retoma-se: apagado e revertido contam-se uma vez", async () => verificarRetoma(await cenarioRetoma(reset)));
await caso("D2 na retoma: decisão humana tomada durante a tentativa interrompida ganha ao apagamento", async () => verificarRetomaComDecisao(await cenarioRetomaComDecisao(reset)));
await caso("D2 na retoma: publicação feita durante a pausa não é decisão humana, e volta a PENDING", async () => verificarRetomaComPublicacaoNaPausa(await cenarioRetomaComPublicacaoNaPausa(reset)));
await caso("D2 na retoma: o instante do primeiro arranque passa de uma retoma para a seguinte", async () => verificarRetomaDoArranque(await cenarioRetomaDoArranque(job)));
await caso("D39: o batimento renova-se enquanto o processo vive: reset com batimento antigo fica vivo", async () => {
  const r = await cenarioBatimento(job);
  assert.equal(r.antes, false, "sem batimento, o reset está morto");
  assert.equal(r.vivoDepois, true, "o batimento renovou-o");
  assert.equal(r.depois.state, "deleting", "o batimento não muda o estado");
});
await caso("arranque com trinco entre processos: duas chamadas no mesmo instante, só uma arranca", async () => verificarArranqueSimultaneo(await cenarioArranqueSimultaneo(job)));
await caso("CLI de libertação: reset vivo (batimento recente) não se liberta, mesmo com arranque antigo", async () => {
  const r = await cenarioLibertacao(0.5, ["--execute"]);
  assert.equal(r.saida.status, 1, r.saida.stdout + r.saida.stderr);
  assert.match(r.saida.stdout, /Reset vivo/);
  assert.equal(r.estado.state, "deleting", "o estado fica como estava");
});
await caso("CLI de libertação: --min-age-minutes não numérico recusa-se (NaN não desliga a trava)", async () => {
  const r = await cenarioLibertacao(20, ["--execute", "--min-age-minutes", "abc"]);
  assert.equal(r.saida.status, 2, r.saida.stdout + r.saida.stderr);
  assert.equal(r.estado.state, "deleting", "o estado fica como estava");
});
await caso("CLI de libertação: batimento antigo, sem processo vivo, liberta-se como failed/orphaned", async () => {
  const r = await cenarioLibertacao(20, ["--execute"]);
  assert.equal(r.saida.status, 0, r.saida.stdout + r.saida.stderr);
  assert.equal(r.estado.state, "failed");
  assert.equal(r.estado.failureReason, "orphaned");
});
await caso("D2 numa tentativa falhada: a decisão humana depois do primeiro arranque ganha ao apagamento da tentativa seguinte", async () => verificarFalhaDepoisDeDecisao(await cenarioFalhaDepoisDeDecisao(reset)));
await caso("D2 depois de um reset concluído: o arranque seguinte abre uma janela nova", async () => {
  const { retomado, antigo } = await cenarioCompletoNovaJanela();
  assert.notEqual(retomado.inicioDoPrimeiroArranque, antigo, "um reset concluído não herda a janela antiga");
  assert.equal(retomado.retomadoDe, null);
  assert.equal(retomado.deleted, 0, "um reset concluído não traz contadores");
});
await caso("DBG-181: escrita de progresso sobre estado ilegível recusa-se, e o ficheiro fica como estava", async () => verificarEscritaSobreIlegivel(await cenarioEscritaSobreIlegivel(job)));
await caso("verificação antes da varredura: produto que aparece depois da listagem não tem a fila tocada, e o reset não fica concluído", async () => verificarPublicadoDuranteOReset(await cenarioPublicadoDuranteOReset(reset)));
await caso("contagem da Shopify sem o campo: não é zero, e o reset não fica concluído", async () => verificarContagemSemCampo(await cenarioContagemSemCampo(reset)));
await caso("CLI de libertação: com o trinco de arranque ocupado, espera, recusa-se e não escreve", async () => {
  const r = await cenarioCliContraTrinco();
  assert.notEqual(r.saida.status, 0, r.saida.stdout + r.saida.stderr);
  assert.match(r.saida.stdout + r.saida.stderr, /trinco de arranque ocupado/);
  assert.equal(r.estado.state, "deleting", "o estado fica como estava");
});
await caso("apagamento falhado com a loja vazia: o item fica PUBLISHED com o vínculo, e o reset não fica concluído", async () => verificarErroComLojaVazia(await cenarioErroComLojaVazia(reset)));
await caso("DBG-180 no cliente: pedido com tempo limite sai com ShopifyTimeoutError, sem esperar pela resposta", async () => verificarClienteTempoLimite(await cenarioClienteTempoLimite(await modulo("lib/importer/shopifyClient.js"))));
await caso("DBG-180 no reset: apagamento pendurado para como failed, e a tentativa seguinte retoma-se com o apagado anterior", async () => verificarTempoLimiteNoApagamento(await cenarioTempoLimiteNoApagamento(reset)));
await caso("DBG-178: a retoma de um reset falhado carrega o apagado e o revertido da tentativa anterior", async () => verificarRetomaDeFalhado(await cenarioRetomaDeFalhado(job)));
await caso("purga: --execute numa loja que não é a de SHOPIFY_SHOP_URL recusa-se antes de tocar em nada", () => {
  const r = spawnSync(process.execPath, [path.join(REPO, "scripts", "catalog", "shopify-products-purge.js"), "--execute", "--shop", "outra-loja.myshopify.com"], {
    encoding: "utf8",
    env: process.env,
    timeout: 30000,
  });
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /Recusado: --execute só corre na loja configurada/);
});
await caso("verificação final: produto que sobrevive ao apagamento → reset não fica concluído", async () => verificarVerificacao(await cenarioVerificacao(reset)));
await caso("reserva da publicação dentro do motor: reserva alheia → recusa, nada apagado", async () => verificarReserva(await cenarioReserva(reset)));
await caso("dry-run: conta produtos e entradas para PENDING, sem escrever", async () => verificarDryRun(await cenarioDryRun(reset)));
await caso("D44: SYNC_ERROR fica como está no reset e é listado", async () => verificarD44(await cenarioD44(reset)));

await caso("recusa com script vivo: mensagem própria, e a da app fica como estava", async () => {
  const script = atv.motivoDeRecusaDoReset({
    indexacaoEmCurso: false,
    atividade: { tipo: "indexacao", origem: "script", motivo: "indexacao em curso (pid 1)" },
  });
  assert.match(script, /script de reindexação/);
  const app = atv.motivoDeRecusaDoReset({
    indexacaoEmCurso: false,
    atividade: { tipo: "indexacao", origem: "app", motivo: "indexacao em curso (pid 1)" },
  });
  assert.match(app, /Aguarda que a indexação em curso termine/);
});

await caso("D42: o ciclo salta a publicação com reset em curso, pelo estado em disco, e regista o salto (estático)", () => {
  const rota = fs.readFileSync(path.join(REPO, "app", "routes", "api.trigger-sync.jsx"), "utf8");
  assert.match(rota, /const resetEmCurso = await isShopifyResetRunning\(shop\);/);
  assert.match(rota, /if \(!resetEmCurso\) \{/);
  assert.match(rota, /await markMarginErosionCycleSkipped\(shop, `publicação de aprovados saltada: \$\{causa\}`\);/);
});

await caso("purga CLI: dry-run por defeito, recusa com atividade e modo degradado (estático)", () => {
  const purga = fs.readFileSync(path.join(REPO, "scripts", "catalog", "shopify-products-purge.js"), "utf8");
  assert.match(purga, /runShopifyCatalogReset\(session, \{ dryRun: true \}\)/);
  assert.match(purga, /recusarSeAtividadeApp\("shopify-products-purge"\)/);
  assert.match(purga, /readDbDegraded\(\)/);
  // Loja vazia não sai antes do motor: a fila com PUBLISHED sem produto também tem de ficar fechada.
  assert.doesNotMatch(purga, /Loja já vazia — nada a fazer/);
  assert.match(purga, /if \(count === 0\) \{\n    console\.log\(`\\nLoja já vazia — o motor reconcilia a fila e verifica o fim\.`\);\n  \}/);
});

// ── Mutações: cada correção tem a sua troca, e a suíte tem de a apanhar ──
// A cópia do módulo é criada fora de mutacaoTemDeFalhar: uma âncora que não existe é erro do teste, não mutação apanhada.
await caso("mutação M1 (2.8): sem falhas.ids.add, o item do apagamento falhado volta a PENDING com a loja vazia", async () => {
  const m = await moduloMutado(SHOPIFY_RESET, "M1", "      falhas.ids.add(product.id);", "      // M1 mutado");
  await mutacaoTemDeFalhar("M1", async () => verificarErroComLojaVazia(await cenarioErroComLojaVazia(m)));
});
await caso("mutação M2 (2.7): sem recentErrors.push, o erro do produto falhado não chega ao estado", async () => {
  const m = await moduloMutado(
    SHOPIFY_RESET,
    "M2",
    "          recentErrors.push({ productId: product.id, sku: product.sku ?? null, message });",
    "          // M2 mutado"
  );
  await mutacaoTemDeFalhar("M2", async () => verificarT2(await cenarioT2(m)));
});
await caso("mutação M3 (D2 no revert): sem D2 no revert por produto, a decisão humana é reescrita", async () => {
  const m = await moduloMutado(
    SHOPIFY_RESET,
    "M3",
    "      if (decidiuUmHumano(item, desde)) {\n        decisoesHumanas += 1;\n        continue;\n      }\n\n      applyDeletedInAdmin",
    "      applyDeletedInAdmin"
  );
  await mutacaoTemDeFalhar("M3", async () => verificarD2(await cenarioD2(m)));
});
await caso("mutação M4 (D35): sem parar na gravação local, o reset continua depois da falha", async () => {
  const m = await moduloMutado(
    SHOPIFY_RESET,
    "M4",
    "          throw new Error(\n            `Fila local não gravou depois de apagar na Shopify: reset parado (D35). ${err?.message || err}`\n          );",
    "          invalidateCurationMemoryCache();"
  );
  await mutacaoTemDeFalhar("M4", async () => verificarT6(await cenarioT6(m)));
});
await caso("mutação M5 (D36): sem o modo degradado antes de cada apagamento, o reset apaga", async () => {
  const m = await moduloMutado(SHOPIFY_RESET, "M5", "        if (degradado) {", "        if (false) {");
  await mutacaoTemDeFalhar("M5", async () => verificarT6b(await cenarioT6b(m)));
});
await caso("mutação M6 (D38): sem o limite de falhas seguidas, o reset tenta todos", async () => {
  const m = await moduloMutado(
    SHOPIFY_RESET,
    "M6",
    "          if (falhasSeguidas >= LIMITE_FALHAS_SEGUIDAS) {",
    "          if (false) {"
  );
  await mutacaoTemDeFalhar("M6", async () => verificarD38(await cenarioD38(m)));
});
await caso("mutação M7 (D37): sem a segunda leitura, a listagem vazia dá a varredura", async () => {
  const m = await moduloMutado(SHOPIFY_RESET, "M7", "      if (segunda !== 0) {", "      if (false) {");
  await mutacaoTemDeFalhar("M7", async () => verificarT4b(await cenarioT4b(m)));
});
await caso("mutação M8 (retoma): sem carregar o apagado do job, o reset retomado conta-o outra vez", async () => {
  const m = await moduloMutado(SHOPIFY_RESET, "M8", "  let deleted = numero(job.deleted);", "  let deleted = 0;");
  await mutacaoTemDeFalhar("M8", async () => verificarRetoma(await cenarioRetoma(m)));
});
await caso("mutação M9 (verificação final): sem o critério zero na loja e zero PUBLISHED, o reset fica concluído", async () => {
  const m = await moduloMutado(SHOPIFY_RESET, "M9", "  if (restantes !== 0 || publicados !== 0) {", "  if (false) {");
  await mutacaoTemDeFalhar("M9", async () => verificarErroComLojaVazia(await cenarioErroComLojaVazia(m)));
});
await caso("mutação M10 (reserva): sem a recusa com reserva alheia, o motor apaga por cima da publicação", async () => {
  const m = await moduloMutado(
    SHOPIFY_RESET,
    "M10",
    '  if (!reserva) {\n    throw new Error("Já há uma publicação ou um reset Shopify em curso.");\n  }',
    "  if (!reserva) {\n    // M10 mutado\n  }"
  );
  await mutacaoTemDeFalhar("M10", async () => verificarReserva(await cenarioReserva(m)));
});
await caso("mutação M11 (D44): SYNC_ERROR com id volta a PENDING, como antes", async () => {
  const m = await moduloMutado(
    SHOPIFY_RESET,
    "M11",
    '    if (item.status === "SYNC_ERROR") {\n      sincroErro += 1;\n      continue;\n    }',
    '    if (item.status === "SYNC_ERROR" && false) {\n      continue;\n    }'
  );
  await mutacaoTemDeFalhar("M11", async () => verificarD44(await cenarioD44(m)));
});
await caso("mutação M12 (D2 na retoma): o arranque da retoma, e não o primeiro, é o instante do D2", async () => {
  const m = await moduloMutado(SHOPIFY_RESET, "M12", "  const desde = job.inicioDoPrimeiroArranque || job.startedAt || null;", "  const desde = job.startedAt || null;");
  await mutacaoTemDeFalhar("M12", async () => verificarRetomaComDecisao(await cenarioRetomaComDecisao(m)));
});
await caso("mutação M13 (D2 na retoma): a retoma não herda o primeiro arranque", async () => {
  const m = await moduloMutado(SHOPIFY_JOB, "M13", "    const inicioOriginal = herdaJanela ? anterior.inicioDoPrimeiroArranque || anterior.startedAt || inicio : inicio;", "    const inicioOriginal = inicio;");
  await mutacaoTemDeFalhar("M13", async () => verificarRetomaDoArranque(await cenarioRetomaDoArranque(m)));
});
await caso("mutação M14 (D2): publicação feita na pausa volta a ser tratada como decisão humana", async () => {
  const m = await moduloMutado(SHOPIFY_RESET, "M14", '  if (item.status === "PUBLISHED") return false;\n', "  // M14 mutado\n");
  await mutacaoTemDeFalhar("M14", async () => verificarRetomaComPublicacaoNaPausa(await cenarioRetomaComPublicacaoNaPausa(m)));
});
await caso("mutação M15 (D39): sem o batimento, o reset parado expira", async () => {
  const m = await moduloMutado(SHOPIFY_JOB, "M15", "    pendente = writeShopifyResetStatus(shop, {}).catch(() => {});", "    void shop;");
  await mutacaoTemDeFalhar("M15", async () => {
    const r = await cenarioBatimento(m);
    assert.equal(r.vivoDepois, true);
  });
});
await caso("mutação M16 (D39): o motor não liga o batimento (estático: o reset tem de o ligar e parar)", async () => {
  const texto = fs.readFileSync(path.join(REPO, SHOPIFY_RESET), "utf8");
  const antigo = "  const pararBatimento = iniciarBatimento(shop);";
  assert.equal(texto.split(antigo).length - 1, 1, "M16: a âncora tem de existir uma vez");
  await mutacaoTemDeFalhar("M16", async () => batimentoLigadoNoMotor(texto.replace(antigo, "  const pararBatimento = () => {};")));
});
await caso("mutação M17 (trinco): sem trinco por instante de arranque, dois arranques passam", async () => {
  const m = await moduloMutado(SHOPIFY_JOB, "M17", "  return comTrincoDeArranque(shop, async () => {", "  return (async () => {");
  await mutacaoTemDeFalhar("M17", async () => verificarArranqueSimultaneo(await cenarioArranqueSimultaneo(m)));
});
await caso("mutação M18 (D2 no arranque): a janela só se herda de uma retoma de estado ativo, e não de um reset falhado", async () => {
  const m = await moduloMutado(SHOPIFY_JOB, "M18", "    const inicioOriginal = herdaJanela ? anterior.inicioDoPrimeiroArranque || anterior.startedAt || inicio : inicio;", "    const inicioOriginal = retoma ? anterior.inicioDoPrimeiroArranque || anterior.startedAt || inicio : inicio;");
  await mutacaoTemDeFalhar("M18", async () => verificarFalhaDepoisDeDecisao(await cenarioFalhaDepoisDeDecisao(m)));
});
await caso("mutação M19 (DBG-181): a escrita sobre estado ilegível passa, e apaga a janela do D2", async () => {
  const m = await moduloMutado(SHOPIFY_JOB, "M19", "    if (prev.ilegivel) {\n      throw new Error(\"Estado do reset ilegível: a escrita recusa-se para não apagar a janela do D2.\");\n    }", "    // M19 mutado");
  await mutacaoTemDeFalhar("M19", async () => verificarEscritaSobreIlegivel(await cenarioEscritaSobreIlegivel(m)));
});
await caso("mutação M20 (sweep): sem verificar a loja antes da varredura, a fila de um produto vivo é revertida", async () => {
  const m = await moduloMutado(SHOPIFY_RESET, "M20", "    await verificarLojaVazia(client);\n", "    // M20 mutado\n");
  await mutacaoTemDeFalhar("M20", async () => verificarPublicadoDuranteOReset(await cenarioPublicadoDuranteOReset(m)));
});
await caso("mutação M21 (contagem): sem o erro de contagem em falta, a loja aparece vazia", async () => {
  const m = await moduloMutado(SHOPIFY_RESET, "M21", "    throw new Error(\"A Shopify não devolveu a contagem de produtos. Reset parado.\");", "    // M21 mutado");
  await mutacaoTemDeFalhar("M21", async () => verificarContagemSemCampo(await cenarioContagemSemCampo(m)));
});
await caso("mutação M22 (CLI de libertação): sem o trinco de arranque, a CLI escreve por cima de um arranque", async () => {
  const copia = copiaMutada("scripts/catalog/reset-lock-release.js", "M22", "  return comTrincoDeArranque(SHOP, libertar);", "  return libertar();");
  try {
    await mutacaoTemDeFalhar("M22", async () => {
      const r = await cenarioCliContraTrinco(copia);
      assert.notEqual(r.saida.status, 0, "com o trinco ocupado, a CLI não pode escrever");
      assert.equal(r.estado.state, "deleting", "o estado fica como estava");
    });
  } finally {
    fs.rmSync(copia, { force: true });
  }
});
await caso("mutação M23 (purga): sem a recusa de loja diferente, --execute chega ao motor", async () => {
  const copia = copiaMutada("scripts/catalog/shopify-products-purge.js", "M23", "  if (SHOP !== lojaConfigurada) {", "  if (false) {");
  try {
    await mutacaoTemDeFalhar("M23", async () => {
      const r = spawnSync(process.execPath, [copia, "--execute", "--shop", "outra-loja.myshopify.com"], { encoding: "utf8", env: process.env, timeout: 30000 });
      assert.equal(r.status, 3, r.stdout + r.stderr);
    });
  } finally {
    fs.rmSync(copia, { force: true });
  }
});

await caso("mutação M24 (DBG-180): sem sinal de tempo limite, o pedido espera pela resposta", async () => {
  const m = await moduloMutado("lib/importer/shopifyClient.js", "M24", "          signal: this.tempoLimiteMs ? AbortSignal.timeout(this.tempoLimiteMs) : undefined,", "          signal: undefined,");
  await mutacaoTemDeFalhar("M24", async () => verificarClienteTempoLimite(await cenarioClienteTempoLimite(m)));
});
await caso("mutação M25 (DBG-180): um pedido pendurado conta como falha de produto, e o reset não para como failed", async () => {
  const m = await moduloMutado(SHOPIFY_RESET, "M25", '          if (err?.code === "SHOPIFY_TIMEOUT") throw err;', "          // M25 mutado");
  await mutacaoTemDeFalhar("M25", async () => verificarTempoLimiteNoApagamento(await cenarioTempoLimiteNoApagamento(m)));
});
await caso("mutação M26 (DBG-178): a retoma só carrega estados ativos, e não o reset falhado", async () => {
  const m = await moduloMutado(SHOPIFY_JOB, "M26", '    const retoma = ESTADOS_ATIVOS.has(anterior.state) || anterior.state === "failed";', "    const retoma = ESTADOS_ATIVOS.has(anterior.state);");
  await mutacaoTemDeFalhar("M26", async () => verificarRetomaDeFalhado(await cenarioRetomaDeFalhado(m)));
});

if (falhas) {
  console.error(`\nshopify-reset-loop: ${falhas} verificação(ões) falharam`);
  process.exit(1);
}
console.log("\nshopify-reset-loop: todos os casos passaram");
