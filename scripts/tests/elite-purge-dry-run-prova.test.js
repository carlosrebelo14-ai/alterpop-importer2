#!/usr/bin/env node
/* eslint-env node */
/**
 * DBG-43. Prova de que a tarefa elite_purge_dry_run não grava nada.
 *
 * Corre scripts/maintenance/elite-purge-dry-run.mjs contra um diretório de dados temporário com a fila,
 * um catálogo numa BD Prisma com o esquema real, e um log. Antes e depois regista o mtime, o tamanho e o
 * hash de todos os ficheiros. Nada pode mudar, e a flag DB_DEGRADED não pode aparecer.
 *
 *   P1  BD boa: as contagens esperadas, nenhum SKU na saída, nenhum ficheiro muda.
 *   P2  BD corrompida: a tarefa sai com erro (catalogo_falhou), nenhum ficheiro muda, e a flag não aparece.
 *   P3  BD em falta: a tarefa sai com erro (bd_em_falta) antes de ligar, e não cria nenhum ficheiro de BD.
 *
 * Usa `prisma db push`, o mesmo caminho do projeto, para criar o esquema real numa BD temporária vazia. Não toca na BD nem na fila reais.
 * Uso: node scripts/tests/elite-purge-dry-run-prova.test.js
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TAREFA = path.join(RAIZ, "scripts", "maintenance", "elite-purge-dry-run.mjs");
const PRISMA = path.join(RAIZ, "node_modules", ".bin", "prisma");
const SCHEMA = path.join(RAIZ, "prisma", "schema.prisma");
const SHOP = "prova.test";
const SEGREDO = "ELITE-PROVA";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "epd-prova-"));

function fotografia(dir) {
  const mapa = {};
  (function percorrer(atual) {
    for (const nome of fs.readdirSync(atual)) {
      const caminho = path.join(atual, nome);
      const st = fs.statSync(caminho);
      if (st.isDirectory()) percorrer(caminho);
      else {
        mapa[path.relative(dir, caminho)] = {
          mtimeMs: st.mtimeMs,
          size: st.size,
          hash: crypto.createHash("sha256").update(fs.readFileSync(caminho)).digest("hex"),
        };
      }
    }
  })(dir);
  return mapa;
}

function ambiente(dir, extra = {}) {
  return {
    PATH: process.env.PATH,
    CURATION_DATA_DIR: dir,
    DATABASE_URL: `file:${path.join(dir, "dev.sqlite")}`,
    SHOPIFY_SHOP_URL: SHOP,
    ...extra,
  };
}

function correrTarefa(dir) {
  return spawnSync(process.execPath, [TAREFA], { cwd: RAIZ, encoding: "utf8", timeout: 120_000, env: ambiente(dir) });
}

function escreverFila(dir) {
  const items = [
    { sku: `${SEGREDO}-SAI-PEN`, status: "PENDING", title_en: "x", shopifyStatus: "DRAFT", metadata: { vendor: "MARCA-PROVA-NAO-PREMIUM", netPrice: 20 } },
    { sku: `${SEGREDO}-SAI-REJ`, status: "REJECTED", title_en: "x", shopifyStatus: "DRAFT", metadata: { vendor: "MARCA-PROVA-NAO-PREMIUM", netPrice: 20, origem: "elite" } },
    { sku: `${SEGREDO}-HUM`, status: "APPROVED", title_en: "x", shopifyStatus: "ACTIVE", metadata: { vendor: "MARCA-PROVA-NAO-PREMIUM", netPrice: 20, origem: "humano", approvedAt: "2026-10-01T00:00:00.000Z" } },
    { sku: `${SEGREDO}-PUB`, status: "PUBLISHED", title_en: "x", shopifyStatus: "ACTIVE", metadata: { vendor: "MARCA-PROVA-NAO-PREMIUM", netPrice: 20, origem: "regra", shopifyProductId: "gid://shopify/Product/1" } },
  ];
  fs.writeFileSync(path.join(dir, "curation-queue.json"), JSON.stringify({ version: 1, updatedAt: null, items }), "utf8");
}

/** BD com o esquema real (migrações) e quatro linhas de catálogo elite; a quinta não tem entrada na fila. */
async function criarBd(dir) {
  const url = `file:${path.join(dir, "dev.sqlite")}`;
  const migra = spawnSync(PRISMA, ["db", "push", "--skip-generate", "--schema", SCHEMA], {
    cwd: RAIZ,
    encoding: "utf8",
    timeout: 300_000,
    env: { PATH: process.env.PATH, DATABASE_URL: url },
  });
  assert.equal(migra.status, 0, `prisma db push falhou: ${migra.stderr || migra.stdout}`);
  process.env.DATABASE_URL = url;
  const { prisma } = await import(pathToFileURL(path.join(RAIZ, "lib", "prisma", "prismaSafe.server.js")).href);
  const linha = (sku) => ({
    shop: SHOP,
    sku,
    title: `Título ${sku}`,
    vendor: "MARCA-PROVA-NAO-PREMIUM",
    categoryMain: "Juguetes",
    categorySegments: "[]",
    netPrice: 20,
    stock: 3,
  });
  await prisma.catalogProduct.createMany({
    data: [`${SEGREDO}-SAI-PEN`, `${SEGREDO}-SAI-REJ`, `${SEGREDO}-HUM`, `${SEGREDO}-PUB`, `${SEGREDO}-SEM`].map(linha),
  });
  await prisma.$disconnect();
  delete process.env.DATABASE_URL;
  const logDir = path.join(dir, "catalog-index");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, `${SHOP}-elite-purge-log.json`), JSON.stringify({ shop: SHOP, removed: 0 }), "utf8");
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

console.log("elite-purge-dry-run-prova");

await check("P1 BD boa: contagens esperadas, sem SKU na saída, nenhum ficheiro muda, sem flag", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "boa-"));
  escreverFila(dir);
  await criarBd(dir);
  const antes = fotografia(dir);
  const r = correrTarefa(dir);
  const depois = fotografia(dir);
  assert.equal(r.status, 0, `código ${r.status}: ${r.stdout}\n${r.stderr}`);
  assert.deepEqual(depois, antes, "nenhum ficheiro pode mudar (mtime, tamanho ou hash)");
  assert.equal(fs.existsSync(path.join(dir, "DB_DEGRADED")), false, "a flag DB_DEGRADED não pode aparecer");
  assert.match(r.stdout, /^EPD: catalogo_total=5$/m);
  assert.match(r.stdout, /^EPD: candidatos=2$/m);
  assert.match(r.stdout, /^EPD: retidos=3$/m);
  assert.match(r.stdout, /^EPD: retidos_decisao_humana=1$/m);
  assert.match(r.stdout, /^EPD: sairiam_PENDING=1$/m);
  assert.match(r.stdout, /^EPD: sairiam_REJECTED=1$/m);
  assert.match(r.stdout, /^EPD: retidos_PUBLISHED=1$/m);
  assert.match(r.stdout, /^EPD: retidos_sem_entrada=1$/m);
  assert.match(r.stdout, /^EPD: retidos_outros_motivos=2$/m);
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(SEGREDO), "a saída não pode ter SKU");
});

await check("P2 BD corrompida: erro catalogo_falhou, nenhum ficheiro muda, sem flag", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "corrompida-"));
  escreverFila(dir);
  fs.writeFileSync(path.join(dir, "dev.sqlite"), crypto.randomBytes(8192));
  const antes = fotografia(dir);
  const r = correrTarefa(dir);
  const depois = fotografia(dir);
  assert.notEqual(r.status, 0, "com a BD corrompida a tarefa tem de falhar");
  assert.match(r.stdout, /^EPD: erro=catalogo_falhou$/m);
  assert.deepEqual(depois, antes, "nenhum ficheiro pode mudar, a BD corrompida incluída");
  assert.equal(fs.existsSync(path.join(dir, "DB_DEGRADED")), false, "a leitura não pode gravar a flag DB_DEGRADED");
});

await check("P3 BD em falta: erro bd_em_falta antes de ligar, e nenhum ficheiro de BD é criado", async () => {
  const dir = fs.mkdtempSync(path.join(tmp, "em-falta-"));
  escreverFila(dir);
  const antes = fotografia(dir);
  const r = correrTarefa(dir);
  const depois = fotografia(dir);
  assert.notEqual(r.status, 0, "sem BD a tarefa tem de falhar, e não dizer zero produtos");
  assert.match(r.stdout, /^EPD: erro=bd_em_falta$/m);
  assert.doesNotMatch(r.stdout, /EPD: catalogo_total=/, "sem BD não pode haver contagens");
  assert.deepEqual(depois, antes, "sem BD, nenhum ficheiro pode ser criado");
  assert.equal(fs.existsSync(path.join(dir, "DB_DEGRADED")), false);
});

await check("P4 leituras por omissão (a rota) numa BD corrompida marcam DB_DEGRADED e lançam DB_DEGRADED", () => {
  const dir = fs.mkdtempSync(path.join(tmp, "rota-"));
  escreverFila(dir);
  fs.writeFileSync(path.join(dir, "dev.sqlite"), crypto.randomBytes(8192));
  const modulo = pathToFileURL(path.join(RAIZ, "lib", "importer", "curation", "eliteCuration.server.js")).href;
  const script = `const { purgeEliteCatalog } = await import(${JSON.stringify(modulo)}); try { await purgeEliteCatalog("prova.test", { executar: false, dependencias: { lerFila: async () => ({ version: 1, items: [] }) } }); console.log("sem erro"); } catch (e) { console.log("codigo=" + e.code); }`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: RAIZ, encoding: "utf8", timeout: 120_000, env: ambiente(dir) });
  assert.match(r.stdout, /codigo=DB_DEGRADED/, `saída: ${r.stdout}\n${r.stderr}`);
  assert.equal(fs.existsSync(path.join(dir, "DB_DEGRADED")), true, "a leitura por omissão marca a flag numa corrupção (Decisão 34)");
});

await check("P5 a fila lida sem efeitos (a rota de dry-run) numa fila corrompida não grava backup nem flag (DBG-125)", () => {
  const dir = fs.mkdtempSync(path.join(tmp, "fila-"));
  fs.writeFileSync(path.join(dir, "curation-queue.json"), "{ partido");
  const modulo = pathToFileURL(path.join(RAIZ, "lib", "importer", "curation", "eliteCuration.server.js")).href;
  const script = `const { lerFilaSemEfeitos } = await import(${JSON.stringify(modulo)}); try { await lerFilaSemEfeitos(); console.log("sem erro"); } catch (e) { console.log("codigo=" + (e.code || e.name)); }`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: RAIZ, encoding: "utf8", timeout: 120_000, env: ambiente(dir) });
  assert.match(r.stdout, /codigo=SyntaxError/, `saída: ${r.stdout}\n${r.stderr}`);
  const extras = fs.readdirSync(dir).filter((n) => n.includes("corrupt") || n === "DB_DEGRADED");
  assert.deepEqual(extras, [], "a leitura sem efeitos não cria backup nem flag");
});

fs.rmSync(tmp, { recursive: true, force: true });
if (falhas) {
  console.error(`\nelite-purge-dry-run-prova: ${falhas} verificação(ões) falharam`);
  process.exit(1);
}
console.log("\nelite-purge-dry-run-prova: todos os casos passaram");
