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
 *   D42: o ciclo salta a publicação com reset em curso, e regista o salto (verificação estática).
 *   Mutações: cada correção tem uma troca que tem de deixar um caso vermelho (cópia do módulo no mesmo diretório).
 *
 * Uso: node scripts/tests/shopify-reset-loop.test.js
 */
import "./_isolate-curation.js";

import assert from "node:assert/strict";
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

globalThis.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  if (query.includes("productDelete(input")) {
    const id = variables.input.id;
    loja.apagar.push(id);
    if (loja.aoApagarPrimeiro && loja.apagar.length === 1) loja.aoApagarPrimeiro();
    if (loja.auth.has(id)) {
      return resposta(401, JSON.stringify({ errors: "[API] Invalid API key or access token" }));
    }
    if (loja.erro.has(id)) {
      return resposta(200, JSON.stringify({ data: { productDelete: { deletedProductId: null, userErrors: [{ field: ["id"], message: "Product not found" }] } } }));
    }
    if (!loja.naoApaga.has(id)) loja.produtos.delete(id);
    return resposta(200, JSON.stringify({ data: { productDelete: { deletedProductId: id, userErrors: [] } } }));
  }
  if (query.includes("productsCount")) {
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
});

// ── Mutações: cada correção tem a sua troca, e a suíte tem de a apanhar ──
// A cópia do módulo é criada fora de mutacaoTemDeFalhar: uma âncora que não existe é erro do teste, não mutação apanhada.
await caso("mutação M1 (2.8): sem falhas.ids.add, o item sem SKU volta a PENDING", async () => {
  const m = await moduloMutado(SHOPIFY_RESET, "M1", "      falhas.ids.add(product.id);", "      // M1 mutado");
  await mutacaoTemDeFalhar("M1", async () => verificarT2b(await cenarioT2b(m)));
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
  await mutacaoTemDeFalhar("M9", async () => verificarVerificacao(await cenarioVerificacao(m)));
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

if (falhas) {
  console.error(`\nshopify-reset-loop: ${falhas} verificação(ões) falharam`);
  process.exit(1);
}
console.log("\nshopify-reset-loop: todos os casos passaram");
