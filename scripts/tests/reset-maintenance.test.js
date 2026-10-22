#!/usr/bin/env node
/* eslint-env node */
/**
 * Driver do reset (scripts/maintenance/reset-maintenance.mjs): dry-run, execução com reserva e saídas do contrato.
 *   Raiz falsa num diretório temporário, com lib/... do motor em stub (os nomes e as assinaturas de 605e20a). O driver
 *   corre por stdin, como na Fly, com o cwd na raiz falsa. Os stubs registam cada escrita (reset, reserva, marca), e o
 *   teste falha se uma aparecer onde não devia.
 *   Repositório público: as fixtures são sintéticas, e nenhuma sai no stdout nem no stderr do driver.
 *   Mutações: cada caso tem uma âncora trocada no texto do driver (em memória, sem ficheiro). O caso tem de falhar.
 *   Este ficheiro corre dentro de scripts/tests/maintenance.test.js (test:deploy), para entrar na CI.
 * Uso: node scripts/tests/reset-maintenance.test.js
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FONTE = fs.readFileSync(path.join(ROOT, "scripts/maintenance/reset-maintenance.mjs"), "utf8");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reset-maintenance-"));
const LOJA = "loja-sintetica.example";
// Eventos que escrevem. Qualquer um deles num dry-run é uma falha.
const ESCRITAS = ["reset", "reserva:tomar", "reserva:libertar", "marca:publicacao"];
const PREFIXOS_DO_CONTRATO = /^(RS|RS_ESTADO|RS_D2|RS_GUARDAS|RS_RESULTADO|RS_ERRO): /;

const PRODUTOS = [
  { id: "gid://shopify/Product/SINTETICO-001", title: "Título sintético 001", sku: "SKU-SINTETICO-001", tags: ["alterpop"] },
  { id: "gid://shopify/Product/SINTETICO-002", title: "Título sintético 002", sku: "SKU-SINTETICO-002", tags: [] },
  { id: "gid://shopify/Product/SINTETICO-003", title: "Título sintético 003", sku: "SKU-SINTETICO-003", tags: ["alterpop"] },
];
// A fila lê o vínculo à Shopify em metadata.shopifyProductId, como o motor.
const FILA = [
  { sku: "SKU-SINTETICO-001", status: "PUBLISHED", statusChangedAt: "2026-01-01T00:00:00.000Z", metadata: { shopifyProductId: PRODUTOS[0].id } },
  { sku: "SKU-SINTETICO-002", status: "PENDING", statusChangedAt: "2026-01-01T00:00:00.000Z" },
  { sku: "SKU-SINTETICO-003", status: "APPROVED", statusChangedAt: "2026-01-01T00:00:00.000Z" },
];
const IDS_PADRAO = PRODUTOS.map((p) => p.id);

// ---------- stubs do motor (ESM, na raiz falsa) ----------

const STUB = String.raw`import fs from "node:fs";
import path from "node:path";

const ficheiroEstado = path.join(process.cwd(), "estado.json");
const ficheiroRegisto = path.join(process.cwd(), "registo.jsonl");

export function lerEstado() {
  return JSON.parse(fs.readFileSync(ficheiroEstado, "utf8"));
}

export function gravarEstado(estado) {
  fs.writeFileSync(ficheiroEstado, JSON.stringify(estado));
}

export function registar(evento, dados = {}) {
  fs.appendFileSync(ficheiroRegisto, JSON.stringify({ evento, ...dados }) + "\n");
}
`;

const MOTOR_FALSO = {
  "package.json": '{"type": "module"}\n',
  "stub.mjs": STUB,
  "lib/importer/shopify/shopifyReset.server.js": String.raw`import { gravarEstado, lerEstado, registar } from "../../../stub.mjs";

export async function collectProductsForShopifyReset(session, opts = {}) {
  registar("listagem");
  const estado = lerEstado();
  if (estado.erroListagem) {
    const primeiro = estado.produtos[0] || { id: "vazio", sku: "vazio" };
    throw new Error("falha de listagem " + primeiro.id + " " + primeiro.sku);
  }
  return { client: null, products: estado.produtos.map((p) => ({ ...p })), scope: opts.scope || "all" };
}

export async function countShopifyProductsForReset() {
  registar("contagem");
  const estado = lerEstado();
  if (estado.erroContagem) throw new Error("falha de contagem");
  return estado.produtos.length + (estado.contagemFantasma || 0);
}

export async function runShopifyCatalogReset(session, opts = {}) {
  if (opts.dryRun) {
    registar("dry");
    const estado = lerEstado();
    const estadoFinal = {};
    for (const item of estado.fila) {
      const status = item.status === "PUBLISHED" ? "PENDING" : item.status;
      estadoFinal[status] = (estadoFinal[status] || 0) + 1;
    }
    return {
      ok: true,
      dryRun: true,
      produtosNaLoja: estado.produtos.length,
      entradasParaPending: 0,
      sincroErroPreservado: 0,
      estadoFinal,
    };
  }
  registar("reset", { reservaTomada: opts.reservaTomada === true });
  const estado = lerEstado();
  const primeiro = estado.produtos[0] || { id: "vazio", sku: "vazio" };
  // O motor pode escrever na consola, no stdout e no stderr. O driver não deixa sair nada disto.
  console.warn("aviso sintético " + primeiro.sku);
  process.stdout.write("saída sintética " + primeiro.id + "\n");
  process.stderr.write("erro sintético " + primeiro.sku + "\n");
  if (estado.erroResetDb) {
    estado.dbDegradado = { cause: "sintético" };
    gravarEstado(estado);
    throw new Error("falha de reset " + primeiro.id);
  }
  if (estado.erroReset) {
    estado.job = { state: "failed", deleted: 0, failed: 1, revertedLocal: 0 };
    gravarEstado(estado);
    throw new Error("falha de reset " + primeiro.id + " " + primeiro.sku);
  }
  if (estado.criaAoResetar) {
    // Um produto criado na loja depois da conferência: a listagem do motor já o apanha, e o motor apaga-o.
    estado.produtos.push({ id: "gid://shopify/Product/SINTETICO-004", title: "Título sintético 004", sku: "SKU-SINTETICO-004", tags: [] });
  }
  const total = estado.produtos.length;
  const revertidos = estado.fila.filter((i) => i.status === "PUBLISHED").length;
  estado.fila = estado.fila.map((i) => (i.status === "PUBLISHED" ? { ...i, status: "PENDING" } : i));
  estado.produtos = [];
  estado.job = { state: "completed", deleted: total, failed: 0, revertedLocal: revertidos };
  gravarEstado(estado);
  return { ok: true, total, deleted: total, failed: 0, revertedLocal: revertidos };
}
`,
  "lib/importer/shopify/publicacaoEmCurso.js": String.raw`import path from "node:path";
import { gravarEstado, lerEstado, registar } from "../../../stub.mjs";

export function caminhoDoTrincoDePublicacao() {
  return path.join(process.cwd(), "trinco-publicacao.lock");
}

export async function reservarPublicacaoEntreProcessos({ marcar } = {}) {
  registar("reserva:tomar");
  const retirar = typeof marcar === "function" ? marcar() : () => {};
  const estado = lerEstado();
  if (estado.reservaOcupada) {
    retirar();
    return null;
  }
  if (estado.aoReservar) {
    // Uma mudança que chega entre a conferência e a reserva (outro processo, ou a app).
    const { aoReservar, ...resto } = estado;
    gravarEstado({ ...resto, ...aoReservar });
  }
  return {
    aindaTem: async () => true,
    libertar: async () => {
      retirar();
      const depois = lerEstado();
      if (depois.publicaAoLibertar) {
        // Uma publicação que entra logo depois de a reserva sair, como faria a app.
        depois.fila.push({ sku: "SKU-SINTETICO-007", status: "PUBLISHED", statusChangedAt: "2026-01-04T00:00:00.000Z", metadata: { shopifyProductId: "gid://shopify/Product/SINTETICO-007" } });
        gravarEstado(depois);
      }
      registar("reserva:libertar");
    },
  };
}
`,
  "lib/curation/atividadeApp.js": String.raw`import { gravarEstado, lerEstado, registar } from "../../stub.mjs";

export function marcarAtividadeApp({ tipo }) {
  registar("marca:" + tipo);
  // Como o motor real: a marca fica no disco com o pid deste processo, e conta como atividade da app.
  const estado = lerEstado();
  estado.atividade = { tipo, pid: process.pid, origem: "app", motivo: "marca sintética do driver" };
  gravarEstado(estado);
  return () => {
    const depois = lerEstado();
    depois.atividade = null;
    gravarEstado(depois);
  };
}

export function atividadeAppEmCurso() {
  return lerEstado().atividade || null;
}

export function scriptDeIndexacaoEmCurso() {
  return lerEstado().script || null;
}
`,
  "lib/importer/catalog/catalogRebuildStatus.server.js": String.raw`import { lerEstado } from "../../../stub.mjs";

export async function readCatalogRebuildStatusFromDisk() {
  return lerEstado().rebuild || { state: "idle", indexing: false };
}
`,
  "lib/health/dbDegraded.js": String.raw`import { lerEstado } from "../../stub.mjs";

export function readDbDegraded() {
  return lerEstado().dbDegradado || null;
}
`,
  "lib/curation/curationQueue.server.js": String.raw`import { lerEstado } from "../../stub.mjs";

export async function lerFicheiroDaFilaSemEfeitos() {
  const estado = lerEstado();
  const items = estado.fila.map((item) => ({ ...item }));
  if (estado.publicadoFantasma && estado.job && estado.job.state === "completed") {
    items.push({ sku: "SKU-SINTETICO-009", status: "PUBLISHED", statusChangedAt: "2026-01-04T00:00:00.000Z", metadata: { shopifyProductId: "gid://shopify/Product/SINTETICO-009" } });
  }
  return { version: 1, items };
}
`,
  "lib/importer/shopify/shopifyResetJob.server.js": String.raw`import { lerEstado } from "../../../stub.mjs";

export async function readShopifyResetStatus() {
  return lerEstado().job || { state: "idle", deleted: 0, failed: 0, revertedLocal: 0 };
}

export async function isShopifyResetRunning() {
  return lerEstado().resetVivo === true;
}
`,
  "lib/importer/shopify/shopifySyncJob.server.js": String.raw`import { lerEstado } from "../../../stub.mjs";

export async function readShopifySyncStatus() {
  return lerEstado().sync || { state: "idle" };
}
`,
};

// ---------- ajudas ----------

let sequencia = 0;

function estadoBase() {
  return {
    produtos: PRODUTOS.map((p) => ({ ...p })),
    fila: FILA.map((i) => ({ ...i })),
    atividade: null,
    script: null,
    rebuild: { state: "idle", indexing: false },
    dbDegradado: null,
    reservaOcupada: false,
    resetVivo: false,
    sync: { state: "idle" },
    job: { state: "idle", deleted: 0, failed: 0, revertedLocal: 0 },
    erroListagem: false,
    erroReset: false,
  };
}

/** Raiz falsa nova: os stubs do motor e o estado, com o que o caso pede por cima. */
function novaRaiz(parcial = {}) {
  sequencia += 1;
  const raiz = path.join(tmp, "raiz-" + sequencia);
  for (const [relativo, texto] of Object.entries(MOTOR_FALSO)) {
    const destino = path.join(raiz, relativo);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, texto);
  }
  fs.writeFileSync(path.join(raiz, "estado.json"), JSON.stringify({ ...estadoBase(), ...parcial }));
  return raiz;
}

const lerEstado = (raiz) => JSON.parse(fs.readFileSync(path.join(raiz, "estado.json"), "utf8"));
const textoDoEstado = (raiz) => fs.readFileSync(path.join(raiz, "estado.json"), "utf8");

function lerRegisto(raiz) {
  const ficheiro = path.join(raiz, "registo.jsonl");
  if (!fs.existsSync(ficheiro)) return [];
  return fs.readFileSync(ficheiro, "utf8").split("\n").filter(Boolean).map((linhaJson) => JSON.parse(linhaJson));
}
const eventos = (raiz) => lerRegisto(raiz).map((e) => e.evento);
const escritas = (raiz) => eventos(raiz).filter((evento) => ESCRITAS.includes(evento));

/** Impressão digital esperada, feita à parte: sha256 dos ids por ordem de código, 12 hex. */
function impressaoEsperada(ids) {
  const ordenados = [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return crypto.createHash("sha256").update(ordenados.join("\n")).digest("hex").slice(0, 12);
}

/** Corre o driver como a Fly: o código pelo stdin, com o cwd na raiz falsa. `fonte` deixa passar uma mutação. */
function correr(raiz, { modo, ok, fonte = FONTE, env = {} }) {
  return new Promise((resolver) => {
    const ambiente = { PATH: process.env.PATH, SHOPIFY_SHOP_URL: LOJA, ...env };
    if (modo !== undefined) ambiente.RESET_MODO = modo;
    if (ok !== undefined) ambiente.RESET_OK = ok;
    const filho = spawn(process.execPath, ["--input-type=module", "-"], { cwd: raiz, env: ambiente });
    let stdout = "";
    let stderr = "";
    filho.stdout.on("data", (d) => (stdout += d));
    filho.stderr.on("data", (d) => (stderr += d));
    filho.stdin.on("error", () => {});
    const reloj = setTimeout(() => filho.kill("SIGKILL"), 60_000);
    filho.on("close", (status) => {
      clearTimeout(reloj);
      resolver({ status, stdout, stderr, linhas: stdout.split("\n").filter(Boolean) });
    });
    filho.stdin.end(fonte);
  });
}

const linhasDe = (r, prefixo) => r.linhas.filter((l) => l.startsWith(prefixo));

/** Uma linha única com o prefixo, ou falha. */
function linhaUnica(r, prefixo) {
  const encontradas = linhasDe(r, prefixo);
  assert.equal(encontradas.length, 1, `esperava uma linha ${prefixo}, há ${encontradas.length}: ${r.linhas.join(" | ")}`);
  return encontradas[0];
}

function impressaoDe(r) {
  const m = /impressao=([0-9a-f]{12})$/.exec(linhaUnica(r, "RS:"));
  assert.ok(m, "a linha RS tem a impressão, com 12 hex");
  return m[1];
}

/** Só linhas do contrato no stdout. */
function assertFormatoDoContrato(r) {
  for (const l of r.linhas) assert.match(l, PREFIXOS_DO_CONTRATO, `linha fora do contrato: ${l}`);
}

/** Nenhum dado da fixture sai no stdout nem no stderr. */
const SEGREDOS = ["SKU-SINTETICO", "gid://", "SINTETICO", "Título sintético"];
function assertSemDados(r, nome) {
  for (const s of SEGREDOS) {
    assert.ok(!r.stdout.includes(s), `${nome}: o stdout tem dados da loja (${s})`);
    assert.ok(!r.stderr.includes(s), `${nome}: o stderr tem dados da loja (${s})`);
  }
}

// ---------- casos (recebem a fonte do driver, real ou mutada) ----------

async function casoR1(fonte = FONTE) {
  const raiz = novaRaiz();
  const antes = textoDoEstado(raiz);
  const r = await correr(raiz, { modo: "dry", fonte });
  assert.equal(r.status, 0, `saída ${r.status}`);
  assert.deepEqual(escritas(raiz), [], "o dry-run não escreve: nem reset, nem reserva, nem marca");
  assert.equal(textoDoEstado(raiz), antes, "o estado da loja e da fila fica igual");
  assertFormatoDoContrato(r);
  assert.deepEqual(r.linhas, [
    `RS: produtos_na_loja=3 itens_publicados=1 impressao=${impressaoEsperada(IDS_PADRAO)}`,
    "RS_ESTADO: estado=APPROVED n=1",
    "RS_ESTADO: estado=PENDING n=2",
    "RS_ESTADO: estado=PUBLISHED n=0",
    "RS_ESTADO: estado=REJECTED n=0",
    "RS_ESTADO: estado=SYNC_ERROR n=0",
    "RS_D2: decisoes_humanas_mantidas=0",
    "RS_GUARDAS: indexacao=livre reserva=livre trinco=livre db_degradado=nao",
  ]);

  // Retoma (D2): decisões humanas depois do primeiro arranque, e o estado final como o motor o deixa.
  // Com vínculo e decididas: ficam (sku3). PUBLISHED e itens com vínculo não decididos: voltam a PENDING (sku1, sku6).
  // Sem vínculo, decididos: ficam e não contam (sku4). SYNC_ERROR: fica e não conta (sku5).
  const retoma = novaRaiz({
    job: { state: "failed", inicioDoPrimeiroArranque: "2026-01-02T00:00:00.000Z", deleted: 0, failed: 1, revertedLocal: 0 },
    fila: [
      { sku: "SKU-SINTETICO-001", status: "PUBLISHED", statusChangedAt: "2026-01-03T00:00:00.000Z", metadata: { shopifyProductId: PRODUTOS[0].id } },
      { sku: "SKU-SINTETICO-002", status: "PENDING", statusChangedAt: "2026-01-01T00:00:00.000Z" },
      { sku: "SKU-SINTETICO-003", status: "APPROVED", statusChangedAt: "2026-01-03T00:00:00.000Z", metadata: { shopifyProductId: PRODUTOS[2].id } },
      { sku: "SKU-SINTETICO-004", status: "APPROVED", statusChangedAt: "2026-01-03T00:00:00.000Z" },
      { sku: "SKU-SINTETICO-005", status: "SYNC_ERROR", statusChangedAt: "2026-01-03T00:00:00.000Z", metadata: { shopifyProductId: PRODUTOS[1].id } },
      { sku: "SKU-SINTETICO-006", status: "APPROVED", statusChangedAt: "2026-01-01T00:00:00.000Z", metadata: { shopifyProductId: "gid://shopify/Product/SINTETICO-006" } },
    ],
  });
  const d = await correr(retoma, { modo: "dry", fonte });
  assert.equal(d.status, 0, `saída ${d.status}`);
  assert.equal(linhaUnica(d, "RS_D2:"), "RS_D2: decisoes_humanas_mantidas=1", "só a decisão com vínculo depois do arranque conta");
  assert.deepEqual(
    linhasDe(d, "RS_ESTADO:"),
    [
      "RS_ESTADO: estado=APPROVED n=2",
      "RS_ESTADO: estado=PENDING n=3",
      "RS_ESTADO: estado=PUBLISHED n=0",
      "RS_ESTADO: estado=REJECTED n=0",
      "RS_ESTADO: estado=SYNC_ERROR n=1",
    ],
    "estado final como o motor o deixa",
  );
  assert.deepEqual(escritas(retoma), [], "o dry-run de retoma também não escreve");

  // Trinco com titular vivo (este processo) e recente: ocupado no dry-run, sem o tomar.
  const comTrinco = novaRaiz();
  fs.writeFileSync(path.join(comTrinco, "trinco-publicacao.lock"), JSON.stringify({ pid: process.pid, em: new Date().toISOString(), token: "sintetico" }));
  const t = await correr(comTrinco, { modo: "dry", fonte });
  assert.match(linhaUnica(t, "RS_GUARDAS:"), /trinco=ocupada/, "trinco vivo e recente conta como ocupado");
  assert.deepEqual(escritas(comTrinco), [], "o trinco é lido, não tomado");

  // Trinco sem renovação há mais de 10 min: obsoleto, livre.
  const velho = novaRaiz();
  const ha20Min = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(velho, "trinco-publicacao.lock"), JSON.stringify({ pid: process.pid, em: ha20Min, token: "sintetico" }));
  const v = await correr(velho, { modo: "dry", fonte });
  assert.match(linhaUnica(v, "RS_GUARDAS:"), /trinco=livre/, "trinco sem renovação há 20 min é obsoleto");
}

async function casoR2(fonte = FONTE) {
  // Impressão diferente: recusa antes de tomar a reserva. Nada é escrito: nem trinco, nem marca, nem reset.
  const raiz = novaRaiz();
  const r = await correr(raiz, { modo: "execute", ok: "000000000000", fonte });
  assert.equal(r.status, 3, `impressão diferente sai com 3, saiu ${r.status}`);
  assert.deepEqual(linhasDe(r, "RS_ERRO:"), ["RS_ERRO: classe=impressao_diferente"]);
  assert.deepEqual(escritas(raiz), [], "impressão diferente não escreve: nem reserva, nem marca, nem reset");
  assert.equal(lerEstado(raiz).produtos.length, 3, "a loja fica como estava");
  assert.deepEqual(linhasDe(r, "RS_RESULTADO:"), [], "sem resultado: não se apagou nada");
}

async function casoR2b(fonte = FONTE) {
  // A loja muda entre a conferência e a reserva: a segunda conferência, com a reserva tomada, recusa.
  const extra = { id: "gid://shopify/Product/SINTETICO-004", title: "Título sintético 004", sku: "SKU-SINTETICO-004", tags: [] };
  const raiz = novaRaiz({ aoReservar: { produtos: [...PRODUTOS.map((p) => ({ ...p })), extra] } });
  const r = await correr(raiz, { modo: "execute", ok: impressaoEsperada(IDS_PADRAO), fonte });
  assert.equal(r.status, 3, `loja mudada depois da conferência sai com 3, saiu ${r.status}`);
  assert.deepEqual(linhasDe(r, "RS_ERRO:"), ["RS_ERRO: classe=impressao_diferente"]);
  assert.ok(!eventos(raiz).includes("reset"), "nada apagado");
  assert.ok(eventos(raiz).includes("reserva:libertar"), "a reserva sai mesmo com a recusa");
  assert.equal(lerEstado(raiz).produtos.length, 4, "a loja fica como a deixou a mudança");
}

async function casoR3(fonte = FONTE) {
  const raiz = novaRaiz();
  const r = await correr(raiz, { modo: "execute", ok: impressaoEsperada(IDS_PADRAO), fonte });
  assert.equal(r.status, 0, `saída ${r.status}`);
  const sequencia = eventos(raiz).filter((e) => ["reserva:tomar", "marca:publicacao", "reset", "reserva:libertar"].includes(e));
  assert.deepEqual(sequencia, ["reserva:tomar", "marca:publicacao", "reset", "reserva:libertar"], "reserva tomada antes do reset e libertada depois");
  const reset = lerRegisto(raiz).find((e) => e.evento === "reset");
  assert.equal(reset.reservaTomada, true, "o reset corre com a reserva que o driver tomou");
  assert.equal(lerEstado(raiz).produtos.length, 0, "a loja fica vazia");
  assert.equal(
    linhaUnica(r, "RS_RESULTADO:"),
    "RS_RESULTADO: modo=execute apagados=3 revertidos=1 falhados=0 produtos_restantes=0 published_restantes=0",
  );
  assertFormatoDoContrato(r);
}

async function casoR4(fonte = FONTE) {
  const oks = [undefined, "", "000000000000x", "ABCDEF123456", "0123456789", "0123456789abc", "zzzzzzzzzzzz", "0123456789ab\n"];
  for (const ok of oks) {
    const raiz = novaRaiz();
    const r = await correr(raiz, { modo: "execute", ok, fonte });
    assert.equal(r.status, 64, `RESET_OK ${JSON.stringify(ok)} sai com 64, saiu ${r.status}`);
    assert.deepEqual(r.linhas, ["RS_ERRO: classe=entrada_invalida"], "só a classe");
    assert.deepEqual(eventos(raiz), [], "nada chamado no motor");
  }
  for (const modo of [undefined, "apagar"]) {
    const raiz = novaRaiz();
    const r = await correr(raiz, { modo, ok: impressaoEsperada(IDS_PADRAO), fonte });
    assert.equal(r.status, 64, `RESET_MODO ${String(modo)} sai com 64`);
    assert.deepEqual(eventos(raiz), [], "nada chamado no motor");
  }
}

async function casoR5(fonte = FONTE) {
  const agora = new Date().toISOString();
  const casos = [
    { nome: "indexação (marcador da app)", estado: { atividade: { tipo: "indexacao", pid: 1, origem: "app", motivo: "sintético" } }, classe: "guarda" },
    { nome: "indexação (script)", estado: { script: { tipo: "script", causa: "script", pid: 1, motivo: "sintético" } }, classe: "guarda" },
    { nome: "indexação (reconstrução em curso)", estado: { rebuild: { state: "running", indexing: true } }, classe: "guarda" },
    { nome: "reconstrução em curso sem indexing", estado: { rebuild: { state: "running", indexing: false } }, classe: "guarda" },
    { nome: "atividade ilegível", estado: { atividade: { tipo: "desconhecida", pid: null, motivo: "sintético" } }, classe: "guarda" },
    { nome: "BD degradada", estado: { dbDegradado: { cause: "sintético", at: null } }, classe: "guarda" },
    { nome: "publicação (marcador)", estado: { atividade: { tipo: "publicacao", pid: 1, origem: "app", motivo: "sintético" } }, classe: "reserva_ocupada" },
    { nome: "reserva tomada noutro processo", estado: { reservaOcupada: true }, classe: "reserva_ocupada" },
    { nome: "reset já em curso", estado: { resetVivo: true }, classe: "reserva_ocupada" },
    { nome: "sync Shopify a correr", estado: { sync: { state: "running", updatedAt: agora } }, classe: "reserva_ocupada" },
    { nome: "sync Shopify a correr sem data", estado: { sync: { state: "running" } }, classe: "reserva_ocupada" },
  ];
  for (const c of casos) {
    const raiz = novaRaiz(c.estado);
    const r = await correr(raiz, { modo: "execute", ok: impressaoEsperada(IDS_PADRAO), fonte });
    assert.equal(r.status, 4, `${c.nome}: sai com 4, saiu ${r.status}`);
    assert.deepEqual(linhasDe(r, "RS_ERRO:"), [`RS_ERRO: classe=${c.classe}`], c.nome);
    assert.ok(!eventos(raiz).includes("reset"), `${c.nome}: nada apagado`);
    assert.equal(lerEstado(raiz).produtos.length, 3, `${c.nome}: a loja fica como estava`);
  }
}

async function casoR6(fonte = FONTE) {
  const ordem = PRODUTOS.map((p) => ({ ...p }));
  const a = await correr(novaRaiz({ produtos: ordem }), { modo: "dry", fonte });
  const b = await correr(novaRaiz({ produtos: ordem.slice().reverse() }), { modo: "dry", fonte });
  const c = await correr(novaRaiz({ produtos: ordem.slice(1) }), { modo: "dry", fonte });
  for (const r of [a, b, c]) assert.equal(r.status, 0, `saída ${r.status}`);
  assert.equal(impressaoDe(a), impressaoEsperada(IDS_PADRAO), "a impressão é o sha256 dos ids, por ordem de código");
  assert.equal(impressaoDe(b), impressaoDe(a), "a mesma lista noutra ordem dá a mesma impressão");
  assert.notEqual(impressaoDe(c), impressaoDe(a), "uma lista com um produto a menos dá outra impressão");
}

async function casoR7(fonte = FONTE) {
  const sucesso = await correr(novaRaiz(), { modo: "dry", fonte });
  const listagem = await correr(novaRaiz({ erroListagem: true }), { modo: "dry", fonte });
  const reset = await correr(novaRaiz({ erroReset: true }), { modo: "execute", ok: impressaoEsperada(IDS_PADRAO), fonte });
  assert.equal(sucesso.status, 0, `dry ${sucesso.status}`);
  assert.equal(listagem.status, 2, `erro de listagem sai com 2, saiu ${listagem.status}`);
  assert.deepEqual(linhasDe(listagem, "RS_ERRO:"), ["RS_ERRO: classe=leitura_falhou"]);
  assert.equal(reset.status, 1, `erro do motor sai com 1, saiu ${reset.status}`);
  assert.deepEqual(linhasDe(reset, "RS_ERRO:"), ["RS_ERRO: classe=motor_falhou"]);
  for (const [nome, r] of [
    ["dry", sucesso],
    ["listagem", listagem],
    ["reset", reset],
  ]) {
    assertSemDados(r, nome);
    assert.ok(!r.stdout.includes("://"), `${nome}: nenhum URL no stdout`);
  }
}

async function casoR8(fonte = FONTE) {
  const vazio = { produtos: [], fila: [{ sku: "SKU-SINTETICO-002", status: "PENDING", statusChangedAt: "2026-01-01T00:00:00.000Z" }] };
  const a = await correr(novaRaiz(vazio), { modo: "dry", fonte });
  const b = await correr(novaRaiz(vazio), { modo: "dry", fonte });
  assert.equal(a.status, 0, `dry com lista vazia sai com 0, saiu ${a.status}`);
  assert.equal(b.status, 0, `segunda corrida sai com 0, saiu ${b.status}`);
  assert.equal(impressaoDe(a), impressaoEsperada([]), "a lista vazia tem impressão própria");
  assert.equal(impressaoDe(a), impressaoDe(b), "a mesma em duas corridas");
  assert.match(linhaUnica(a, "RS:"), /produtos_na_loja=0 /);

  // Loja vazia sem PUBLISHED: o motor corre e fecha o reset (D37). Nada a apagar, e o resultado sai com zeros.
  const raiz = novaRaiz(vazio);
  const e = await correr(raiz, { modo: "execute", ok: impressaoDe(a), fonte });
  assert.equal(e.status, 0, `execução com lista vazia sai com 0, saiu ${e.status}`);
  assert.ok(eventos(raiz).includes("reset"), "com a loja vazia o motor corre, e é ele que fecha o reset");
  assert.equal(
    linhaUnica(e, "RS_RESULTADO:"),
    "RS_RESULTADO: modo=execute apagados=0 revertidos=0 falhados=0 produtos_restantes=0 published_restantes=0",
  );

  // Loja vazia com uma entrada PUBLISHED (apagada à mão no admin): o motor reverte-a e fecha o reset.
  const comPublicado = novaRaiz({
    produtos: [],
    fila: [{ sku: "SKU-SINTETICO-004", status: "PUBLISHED", statusChangedAt: "2026-01-01T00:00:00.000Z", metadata: { shopifyProductId: "gid://shopify/Product/SINTETICO-004" } }],
  });
  const p = await correr(comPublicado, { modo: "execute", ok: impressaoDe(a), fonte });
  assert.equal(p.status, 0, `PUBLISHED restante com a loja vazia sai com 0, saiu ${p.status}`);
  assert.equal(
    linhaUnica(p, "RS_RESULTADO:"),
    "RS_RESULTADO: modo=execute apagados=0 revertidos=1 falhados=0 produtos_restantes=0 published_restantes=0",
  );
}

async function casoR9(fonte = FONTE) {
  // Trinco de processo morto: livre. O dry-run só o lê.
  const morto = novaRaiz();
  fs.writeFileSync(path.join(morto, "trinco-publicacao.lock"), JSON.stringify({ pid: 2147483647, em: new Date().toISOString(), token: "sintetico" }));
  const m = await correr(morto, { modo: "dry", fonte });
  assert.match(linhaUnica(m, "RS_GUARDAS:"), /trinco=livre/, "trinco de processo morto é livre");

  // Trinco escrito há 1 min, mas antes do arranque da máquina (uptime a zero): obsoleto, livre.
  const preload = path.join(tmp, "uptime-zero.mjs");
  fs.writeFileSync(preload, 'import os from "node:os";\nos.uptime = () => 0;\n');
  const antesDoArranque = novaRaiz();
  fs.writeFileSync(path.join(antesDoArranque, "trinco-publicacao.lock"), JSON.stringify({ pid: process.pid, em: new Date(Date.now() - 60 * 1000).toISOString(), token: "sintetico" }));
  const u = await correr(antesDoArranque, { modo: "dry", fonte, env: { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } });
  assert.equal(u.status, 0, `saída ${u.status}: ${u.stderr}`);
  assert.match(linhaUnica(u, "RS_GUARDAS:"), /trinco=livre/, "trinco escrito antes do arranque da máquina é obsoleto");

  // Sync Shopify em curso sem data: conta como ativo, e ocupa a reserva.
  const syncSemData = await correr(novaRaiz({ sync: { state: "running" } }), { modo: "dry", fonte });
  assert.match(linhaUnica(syncSemData, "RS_GUARDAS:"), /reserva=ocupada/, "sync em curso sem data conta como ativo");

  // Reconstrução em curso, mesmo com indexing a falso: indexação ocupada.
  const rebuild = await correr(novaRaiz({ rebuild: { state: "running", indexing: false } }), { modo: "dry", fonte });
  assert.match(linhaUnica(rebuild, "RS_GUARDAS:"), /indexacao=ocupada/, "reconstrução em curso conta como indexação");

  // Atividade ilegível: indexação e reserva ocupadas, nos dois sítios.
  const ilegivel = await correr(novaRaiz({ atividade: { tipo: "desconhecida", pid: null, motivo: "sintético" } }), { modo: "dry", fonte });
  assert.match(linhaUnica(ilegivel, "RS_GUARDAS:"), /indexacao=ocupada reserva=ocupada/, "atividade ilegível ocupa as duas guardas");
}

async function casoR10(fonte = FONTE) {
  // Guarda que aparece depois da conferência e antes da reserva: a confirmação com a reserva tomada recusa.
  const raiz = novaRaiz({ aoReservar: { dbDegradado: { cause: "sintético" } } });
  const r = await correr(raiz, { modo: "execute", ok: impressaoEsperada(IDS_PADRAO), fonte });
  assert.equal(r.status, 4, `saída ${r.status}`);
  assert.deepEqual(linhasDe(r, "RS_ERRO:"), ["RS_ERRO: classe=guarda"]);
  assert.ok(!eventos(raiz).includes("reset"), "nada apagado");
  assert.ok(eventos(raiz).includes("reserva:libertar"), "a reserva sai");
}

async function casoR11(fonte = FONTE) {
  // Um produto que sobra depois do reset: o reset não fica concluído.
  const ok = impressaoEsperada(IDS_PADRAO);
  const sobra = await correr(novaRaiz({ contagemFantasma: 1 }), { modo: "execute", ok, fonte });
  assert.equal(sobra.status, 1, `produto que sobra sai com 1, saiu ${sobra.status}`);
  assert.deepEqual(linhasDe(sobra, "RS_ERRO:"), ["RS_ERRO: classe=motor_falhou"]);
  assert.equal(
    linhaUnica(sobra, "RS_RESULTADO:"),
    "RS_RESULTADO: modo=execute apagados=3 revertidos=1 falhados=0 produtos_restantes=1 published_restantes=0",
  );

  // Um PUBLISHED que aparece depois do reset: também não fica concluído.
  const publicado = await correr(novaRaiz({ publicadoFantasma: true }), { modo: "execute", ok, fonte });
  assert.equal(publicado.status, 1, `PUBLISHED que sobra sai com 1, saiu ${publicado.status}`);
  assert.deepEqual(linhasDe(publicado, "RS_ERRO:"), ["RS_ERRO: classe=motor_falhou"]);
  assert.equal(
    linhaUnica(publicado, "RS_RESULTADO:"),
    "RS_RESULTADO: modo=execute apagados=3 revertidos=1 falhados=0 produtos_restantes=0 published_restantes=1",
  );

  // A leitura final falha depois de o reset correr: sai com leitura_falhou, e o resultado sai com ? no lugar da leitura.
  const raizLeitura = novaRaiz({ erroContagem: true });
  const leitura = await correr(raizLeitura, { modo: "execute", ok, fonte });
  assert.equal(leitura.status, 2, `leitura final que falha sai com 2, saiu ${leitura.status}`);
  assert.deepEqual(linhasDe(leitura, "RS_ERRO:"), ["RS_ERRO: classe=leitura_falhou"]);
  assert.equal(
    linhaUnica(leitura, "RS_RESULTADO:"),
    "RS_RESULTADO: modo=execute apagados=3 revertidos=1 falhados=0 produtos_restantes=? published_restantes=0",
  );
  assert.equal(lerEstado(raizLeitura).produtos.length, 0, "o reset correu: a loja está vazia, e a saída diz o que se leu");
}

async function casoR12(fonte = FONTE) {
  // Uma publicação que entra logo depois de a reserva sair não conta como falha do reset: a leitura final é feita com a reserva tomada.
  const raiz = novaRaiz({ publicaAoLibertar: true });
  const r = await correr(raiz, { modo: "execute", ok: impressaoEsperada(IDS_PADRAO), fonte });
  assert.equal(r.status, 0, `saída ${r.status}`);
  assert.equal(
    linhaUnica(r, "RS_RESULTADO:"),
    "RS_RESULTADO: modo=execute apagados=3 revertidos=1 falhados=0 produtos_restantes=0 published_restantes=0",
  );
}

async function casoR13(fonte = FONTE) {
  // A loja cresce entre a conferência e a listagem do motor: o motor apaga também o produto novo. Só se deteta depois.
  const raiz = novaRaiz({ criaAoResetar: true });
  const r = await correr(raiz, { modo: "execute", ok: impressaoEsperada(IDS_PADRAO), fonte });
  assert.equal(r.status, 3, `o que o motor apagou não é a lista aprovada sai com 3, saiu ${r.status}`);
  assert.deepEqual(linhasDe(r, "RS_ERRO:"), ["RS_ERRO: classe=impressao_diferente"]);
  assert.equal(
    linhaUnica(r, "RS_RESULTADO:"),
    "RS_RESULTADO: modo=execute apagados=4 revertidos=1 falhados=0 produtos_restantes=0 published_restantes=0",
  );
}

async function casoR14(fonte = FONTE) {
  // BD degradada a meio do reset: guarda (código 4), e as contagens do que já saiu.
  const raiz = novaRaiz({ erroResetDb: true });
  const r = await correr(raiz, { modo: "execute", ok: impressaoEsperada(IDS_PADRAO), fonte });
  assert.equal(r.status, 4, `BD degradada a meio sai com 4, saiu ${r.status}`);
  assert.deepEqual(linhasDe(r, "RS_ERRO:"), ["RS_ERRO: classe=guarda"]);
  assert.equal(
    linhaUnica(r, "RS_RESULTADO:"),
    "RS_RESULTADO: modo=execute apagados=0 revertidos=0 falhados=0 produtos_restantes=3 published_restantes=1",
  );
}

// ---------- execução ----------

/** Troca uma âncora que tem de existir exatamente uma vez no texto. Erro do teste, fora de `mutante`. */
function trocaUma(texto, nome, antigo, novo) {
  const vezes = texto.split(antigo).length - 1;
  if (vezes !== 1) throw new Error(`mutação ${nome}: a âncora tem de existir uma vez (existe ${vezes}x)`);
  return texto.replace(antigo, () => novo);
}

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

/** Mutação que tem de ser apanhada: o caso, com o driver mutado, tem de falhar. */
async function mutante(nome, antigo, novo, caso) {
  await check(`mutação ${nome}`, async () => {
    const mutada = trocaUma(FONTE, nome, antigo, novo);
    let apanhou = false;
    try {
      await caso(mutada);
    } catch {
      apanhou = true;
    }
    if (!apanhou) throw new Error(`mutação ${nome}: o caso não a apanhou`);
  });
}

console.log("(a) dry-run: nada escreve, e as linhas são as do contrato");
await check("R1 dry não escreve: linhas do contrato, D2 e estado final como o motor, trinco lido", () => casoR1());
await mutante("R1-dry-chama-o-reset", "runShopifyCatalogReset({ shop }, { dryRun: true })", "runShopifyCatalogReset({ shop }, {})", casoR1);
await mutante(
  "R1-d2-conta-sync-error",
  'item.status !== "SYNC_ERROR" && item.metadata?.shopifyProductId && decidiuUmHumano(item, desde)',
  "item.metadata?.shopifyProductId && decidiuUmHumano(item, desde)",
  casoR1,
);
await mutante(
  "R1-d2-sem-vinculo",
  'item.status !== "SYNC_ERROR" && item.metadata?.shopifyProductId && decidiuUmHumano(item, desde)',
  'item.status !== "SYNC_ERROR" && decidiuUmHumano(item, desde)',
  casoR1,
);
await mutante(
  "R1-estado-final-sem-vinculo",
  '(item.status === "PUBLISHED" || item.metadata?.shopifyProductId)',
  '(item.status === "PUBLISHED")',
  casoR1,
);

console.log("(b) execução: impressão, reserva e reset");
await check("R2 impressão diferente recusa antes da reserva: código 3, nada escrito", () => casoR2());
await mutante(
  "R2-sem-conferencia-antes-da-reserva",
  'if (impressaoDaLista(idsAntes) !== ok) throw falhar("impressao_diferente");',
  'if (false) throw falhar("impressao_diferente");',
  casoR2,
);
await check("R2b a loja muda depois da conferência: a segunda conferência, com a reserva tomada, recusa", () => casoR2b());
await mutante(
  "R2b-sem-conferencia-depois-da-reserva",
  'if (impressaoDaLista(ids) !== ok) throw falhar("impressao_diferente");',
  'if (false) throw falhar("impressao_diferente");',
  casoR2b,
);
await check("R3 execução com a impressão certa: reserva tomada, reset com reservaTomada, libertada", () => casoR3());
await mutante("R3-reserva-sem-libertar", "await reserva.libertar();", "void reserva;", casoR3);
await mutante(
  "R3-reserva-propria-conta",
  "(!propria && atividade?.tipo === \"publicacao\") ||",
  "(atividade?.tipo === \"publicacao\") ||",
  casoR3,
);

console.log("(c) entradas e guardas");
await check("R4 RESET_OK em falta ou mal formado, ou RESET_MODO desconhecido: código 64, nada chamado", () => casoR4());
await mutante(
  "R4-aceita-qualquer-texto",
  'if (modo === "execute" && !RESET_OK_RE.test(ok ?? "")) throw falhar("entrada_invalida");',
  'if (modo === "execute" && ok === undefined) throw falhar("entrada_invalida");',
  casoR4,
);
await check("R5 guardas (indexação, BD degradada, reserva ocupada, reset, sync, atividade ilegível): código 4, nada apagado", () => casoR5());
await mutante(
  "R5-sem-guarda-de-indexacao",
  'guardas.db === "sim" || guardas.indexacao === "ocupada"',
  'guardas.db === "sim" || false',
  casoR5,
);
await mutante("R5-sem-guarda-de-bd", 'guardas.db === "sim" || ', "", casoR5);
await mutante(
  "R5-sem-guarda-de-reserva",
  'if (guardas.reserva === "ocupada") return "reserva_ocupada";',
  'if (false) return "reserva_ocupada";',
  casoR5,
);
await check("R9 guardas e trinco no dry-run: processo morto, prazo do arranque, sync sem data, reconstrução, atividade ilegível", () => casoR9());
await mutante(
  "R9-trinco-sem-pid-morto",
  "if (pid !== null && !processoExiste(pid)) return false;",
  "",
  casoR9,
);
await mutante(
  "R9-trinco-sem-prazo-de-arranque",
  "if (referencia < Date.now() - os.uptime() * 1000) return false;",
  "",
  casoR9,
);
await mutante("R9-sync-sem-data-livre", "if (!Number.isFinite(sinal)) return true;", "if (!Number.isFinite(sinal)) return false;", casoR9);
await mutante("R9-reconstrucao-sem-indexing", '    rebuild?.state === "running" ||', "", casoR9);
await mutante(
  "R9-atividade-ilegivel-sem-indexacao",
  '    atividade?.tipo === "desconhecida" ||\n    Boolean(script) ||',
  "    Boolean(script) ||",
  casoR9,
);
await mutante(
  "R9-atividade-ilegivel-sem-reserva",
  '    atividade?.tipo === "desconhecida" ||\n    syncAtivo(sync) ||',
  "    syncAtivo(sync) ||",
  casoR9,
);
await check("R10 guarda que aparece depois da conferência e antes da reserva: a confirmação recusa, código 4", () => casoR10());
await mutante("R10-confirmacao-sem-efeito", "if (recusaAgora) throw falhar(recusaAgora);", "void recusaAgora;", casoR10);

console.log("(d) impressão, saídas e loja vazia");
await check("R6 a impressão é determinística e não depende da ordem", () => casoR6());
await mutante(
  "R6-sem-ordenar",
  "const ordenados = [...new Set(ids)].sort(comparar);",
  "const ordenados = [...new Set(ids)];",
  casoR6,
);
await check("R7 nenhum dado da loja sai no stdout nem no stderr, nem com erro do motor", () => casoR7());
await mutante(
  "R7-imprime-a-mensagem-do-erro",
  "  } catch {\n    throw falhar(classe);",
  "  } catch (erro) {\n    linha(String(erro?.message));\n    throw falhar(classe);",
  casoR7,
);
await mutante("R7-sem-desvio-do-stderr", "process.stderr.write = descartar;", "", casoR7);
await check("R8 lista vazia: impressão existe e é estável; o motor fecha o reset; PUBLISHED sobrante é revertido", () => casoR8());
await mutante(
  "R8-lista-vazia-lanca",
  "function impressaoDaLista(ids) {",
  'function impressaoDaLista(ids) {\n  if (ids.length === 0) throw new Error("lista vazia");',
  casoR8,
);
await check("R14 BD degradada a meio do reset: código 4 e contagens do que já saiu", () => casoR14());
await mutante(
  "R14-classe-de-bd-sem-guarda",
  'const classe = motor.db.readDbDegraded() ? "guarda" : "motor_falhou";',
  'const classe = "motor_falhou";',
  casoR14,
);

console.log("(e) resultado final e conferência do que o motor apagou");
await check("R11 o reset só fica concluído com zero produtos e zero PUBLISHED; leitura final que falha sai com ?", () => casoR11());
await mutante("R11-sem-conferir-produtos", "final.restantes !== 0 || ", "", casoR11);
await mutante("R11-sem-conferir-published", "|| final.publicados !== 0)", ")", casoR11);
await mutante(
  "R11-leitura-final-sem-tentar",
  "  } catch {\n    return null;\n  }\n}",
  "  } catch (erro) {\n    throw erro;\n  }\n}",
  casoR11,
);
await check("R12 publicação que entra depois de a reserva sair não conta como falha do reset", () => casoR12());
await check("R13 o motor apagou mais do que a lista aprovada: sai com 3 e o resultado já impresso", () => casoR13());
await mutante("R13-sem-conferir-o-total", "if (contadores.total !== esperados) throw falhar(\"impressao_diferente\");", "", casoR13);

fs.rmSync(tmp, { recursive: true, force: true });
if (falhas) {
  console.error(`\nreset-maintenance: ${falhas} verificação(ões) falharam`);
  process.exit(1);
}
console.log("\nreset-maintenance: todos os casos passaram");
