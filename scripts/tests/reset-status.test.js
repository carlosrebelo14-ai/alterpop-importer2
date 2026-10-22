#!/usr/bin/env node
/* eslint-env node */
/**
 * Estado do reset (scripts/maintenance/reset-status.mjs): a linha RS_STATUS e o contrato de saída.
 *   Raiz falsa num diretório temporário, com readShopifyResetStatus em stub: devolve o estado.json da raiz. O script
 *   corre por stdin, como na Fly, com o cwd na raiz falsa.
 *   Repositório público: as fixtures são sintéticas, e nenhuma sai no stdout nem no stderr do script.
 *   Mutações: cada caso tem uma âncora trocada no texto do script (em memória, sem ficheiro). O caso tem de falhar.
 *   Este ficheiro corre dentro de scripts/tests/maintenance.test.js (test:deploy), para entrar na CI.
 * Uso: node scripts/tests/reset-status.test.js
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FONTE = fs.readFileSync(path.join(ROOT, "scripts/maintenance/reset-status.mjs"), "utf8");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reset-status-"));
const LOJA = "loja-sintetica.example";
// Nada disto pode sair no stdout nem no stderr.
const SEGREDOS = ["SKU-SINTETICO", "gid://", "Título sintético", "segredo-sintetico", "CAMINHO-SINTETICO"];

const MOTOR_FALSO = {
  "package.json": '{"type": "module"}\n',
  "lib/importer/shopify/shopifyResetJob.server.js": String.raw`import fs from "node:fs";
import path from "node:path";

export async function readShopifyResetStatus(shop) {
  const estado = JSON.parse(fs.readFileSync(path.join(process.cwd(), "estado.json"), "utf8"));
  if (estado.falhaDeLeitura) throw new Error("falha sintética em CAMINHO-SINTETICO " + process.cwd());
  return { ...estado, shop };
}
`,
};

const ESTADO_FELIZ = {
  jobId: "reset-2026-10-14-b",
  state: "completed",
  total: 57,
  processed: 57,
  deleted: 64,
  failed: 0,
  revertedLocal: 64,
  retomadoDe: "reset-2026-10-14-a",
  startedAt: "2026-10-14T13:00:00.000Z",
  inicioDoPrimeiroArranque: "2026-10-14T12:00:00.000Z",
  finishedAt: "2026-10-14T13:05:00.000Z",
  updatedAt: "2026-10-14T13:05:00.000Z",
  currentTitle: "Título sintético 001",
  error: "segredo-sintetico no texto de erro",
  recentErrors: [{ sku: "SKU-SINTETICO-002", gid: "gid://shopify/Product/SINTETICO-002", message: "segredo-sintetico" }],
};

const ESTADO_INVALIDO = {
  jobId: "../etc/passwd",
  state: "hackeado",
  ilegivel: "sim",
  retomadoDe: "x y",
  total: "57",
  processed: -1,
  deleted: null,
  failed: 1.5,
  revertedLocal: 64,
  startedAt: "ontem",
  inicioDoPrimeiroArranque: 12,
  finishedAt: "2026-10-14T13:05:00Z",
  error: "segredo-sintetico",
};

// ---------- ajudas ----------

let sequencia = 0;

/** Raiz falsa nova: o stub do motor e o estado da leitura. */
function novaRaiz(estado) {
  sequencia += 1;
  const raiz = path.join(tmp, "raiz-" + sequencia);
  for (const [relativo, texto] of Object.entries(MOTOR_FALSO)) {
    const destino = path.join(raiz, relativo);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, texto);
  }
  fs.writeFileSync(path.join(raiz, "estado.json"), JSON.stringify(estado));
  return raiz;
}

function correr(raiz, { fonte = FONTE, env = {} } = {}) {
  return new Promise((resolver) => {
    const filho = spawn(process.execPath, ["--input-type=module", "-"], {
      cwd: raiz,
      env: { PATH: process.env.PATH, SHOPIFY_SHOP_URL: LOJA, ...env },
    });
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

function semSegredos(r, nome) {
  for (const segredo of SEGREDOS) {
    assert.ok(!r.stdout.includes(segredo) && !r.stderr.includes(segredo), `${nome}: "${segredo}" saiu`);
  }
}

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

/** Mutação que tem de ser apanhada: o caso, com o script mutado, tem de falhar. */
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

// ---------- casos ----------

async function casoS1(fonte = FONTE) {
  const raiz = novaRaiz(ESTADO_FELIZ);
  const estadoAntes = fs.readFileSync(path.join(raiz, "estado.json"), "utf8");
  const r = await correr(raiz, { fonte });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.linhas.length, 1, `uma linha no stdout: ${r.stdout}`);
  assert.equal(
    r.linhas[0],
    "RS_STATUS: jobId=reset-2026-10-14-b state=completed ilegivel=nao retomou=sim retomadoDe=reset-2026-10-14-a " +
      "total=57 processed=57 deleted=64 failed=0 revertedLocal=64 startedAt=2026-10-14T13:00:00.000Z " +
      "inicioDoPrimeiroArranque=2026-10-14T12:00:00.000Z finishedAt=2026-10-14T13:05:00.000Z",
  );
  assert.equal(fs.readFileSync(path.join(raiz, "estado.json"), "utf8"), estadoAntes, "só lê: o ficheiro de estado fica igual");
  semSegredos(r, "S1");
}

async function casoS3(fonte = FONTE) {
  const raiz = novaRaiz(ESTADO_INVALIDO);
  const r = await correr(raiz, { fonte });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.linhas[0],
    "RS_STATUS: jobId=- state=- ilegivel=nao retomou=sim retomadoDe=- total=? processed=? deleted=? failed=? " +
      "revertedLocal=64 startedAt=- inicioDoPrimeiroArranque=- finishedAt=2026-10-14T13:05:00Z",
  );
  semSegredos(r, "S3");
}

async function casoS4(fonte = FONTE) {
  const r = await correr(novaRaiz({ ...ESTADO_FELIZ, ilegivel: true, state: "running" }), { fonte });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.linhas[0], /ilegivel=sim /);
  assert.match(r.linhas[0], / state=running /);
  semSegredos(r, "S4");
}

async function casoS5(fonte = FONTE) {
  const vazio = { jobId: null, state: "idle", total: 0, processed: 0, deleted: 0, failed: 0, revertedLocal: 0, retomadoDe: null, startedAt: null, inicioDoPrimeiroArranque: null, finishedAt: null };
  const r = await correr(novaRaiz(vazio), { fonte });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.linhas[0],
    "RS_STATUS: jobId=- state=idle ilegivel=nao retomou=nao retomadoDe=- total=0 processed=0 deleted=0 failed=0 " +
      "revertedLocal=0 startedAt=- inicioDoPrimeiroArranque=- finishedAt=-",
  );
}

async function casoS6(fonte = FONTE) {
  const r = await correr(novaRaiz({ falhaDeLeitura: true }), { fonte });
  assert.equal(r.status, 2, r.stdout);
  assert.equal(r.stdout, "RS_ERRO: classe=leitura_falhou\n");
  semSegredos(r, "S6");
}

async function casoS7(fonte = FONTE) {
  const r = await correr(novaRaiz(ESTADO_FELIZ), { fonte, env: { SHOPIFY_SHOP_URL: "" } });
  assert.equal(r.status, 64, r.stdout);
  assert.equal(r.stdout, "RS_ERRO: classe=entrada_invalida\n");
}

// ---------- execução ----------

console.log("reset_status: linha RS_STATUS, valores inválidos e erros (raiz falsa, motor em stub)");
await check("S1 estado feliz: linha exata, retomou=sim, sem texto livre, ficheiro intacto", () => casoS1());
await check("S3 valores inválidos: ids, datas e contadores que não passam saem como - e ?", () => casoS3());
await check("S4 ficheiro ilegível: ilegivel=sim e o estado como veio", () => casoS4());
await check("S5 sem reset (idle): retomou=nao e os zeros saem", () => casoS5());
await check("S6 leitura falhou: código 2 e só a classe, sem a mensagem de erro", () => casoS6());
await check("S7 sem loja no ambiente: código 64", () => casoS7());

console.log("mutações: cada âncora trocada tem de ser apanhada");
await mutante(
  "S-texto-livre-na-linha",
  "`finishedAt=${data(estado?.finishedAt)}`",
  "`finishedAt=${data(estado?.finishedAt)} erro=${estado?.error}`",
  casoS1,
);
await mutante(
  "S-retomou-sempre-nao",
  "const retomou = estado?.retomadoDe !== null && estado?.retomadoDe !== undefined;",
  "const retomou = false;",
  casoS1,
);
await mutante(
  "S-id-sem-formato",
  'const id = (valor) => (typeof valor === "string" && ID.test(valor) ? valor : "-");',
  'const id = (valor) => String(valor ?? "-");',
  casoS3,
);
await mutante(
  "S-data-sem-formato",
  'const data = (valor) => (typeof valor === "string" && DATA.test(valor) ? valor : "-");',
  'const data = (valor) => String(valor ?? "-");',
  casoS3,
);
await mutante(
  "S-contador-sem-formato",
  'const contador = (valor) => (Number.isInteger(valor) && valor >= 0 ? String(valor) : "?");',
  'const contador = (valor) => String(valor ?? "?");',
  casoS3,
);
await mutante(
  "S-ilegivel-por-verdade",
  'estado?.ilegivel === true ? "sim" : "nao"',
  'estado?.ilegivel ? "sim" : "nao"',
  casoS3,
);
await mutante(
  "S-erro-de-leitura-com-caminho",
  'linha("RS_ERRO: classe=leitura_falhou");\n    return 2;',
  'linha("RS_ERRO: classe=leitura_falhou " + process.cwd());\n    return 2;',
  casoS6,
);

fs.rmSync(tmp, { recursive: true, force: true });
if (falhas) {
  console.error(`\nreset-status: ${falhas} verificação(ões) falharam`);
  process.exit(1);
}
console.log("\nreset-status: todos os casos passaram");
