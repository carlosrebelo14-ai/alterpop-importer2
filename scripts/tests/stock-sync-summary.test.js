#!/usr/bin/env node
/**
 * PR D (briefing 06/11/2026), D1 e D2. O ciclo de stock grava o último resumo C8 em ficheiro, só com números e as causas
 * fixas. O leitor e o script que corre na Fly recusam qualquer ficheiro adulterado.
 * Uso: node scripts/tests/stock-sync-summary.test.js
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  STOCK_SUMMARY_FILE,
  STOCK_SUMMARY_MAX_COUNT,
  buildStockSyncSummary,
  readStockSyncSummary,
  validateStockSyncSummary,
  writeStockSyncSummary,
} from "../../lib/importer/shopify/stockSyncSummary.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FALHA  ${name}\n    ${err.message}`);
  }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "stock-summary-"));
const RESULT = { checked: 2446, lookup: { found: 2400, notFound: 0, errorByCause: { retry_esgotado: 40, timeout: 6 } } };
const imprimir = (dir) =>
  execFileSync("node", [path.join(ROOT, "scripts/maintenance/print-stock-sync-summary.mjs")], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH, CURATION_DATA_DIR: dir } }).trim();

check("ficheiro válido: grava, lê de volta e o script imprime só números", () => {
  const dir = tmp();
  const resumo = buildStockSyncSummary(RESULT, 1289, new Date("2026-11-07T10:30:00.000Z"));
  assert.equal(writeStockSyncSummary(dir, resumo), true);
  const r = readStockSyncSummary(dir);
  assert.equal(r.status, "ok");
  assert.deepEqual(r.summary, { v: 1, ranAt: "2026-11-07T10:30:00.000Z", checked: 2446, found: 2400, notFound: 0, error: 46, errorByCause: { retry_esgotado: 40, timeout: 6 }, desativados: 1289 });
  assert.equal(imprimir(dir), "SSS: estado=ok ranAt=2026-11-07T10:30:00.000Z checked=2446 found=2400 notFound=0 error=46 causas=retry_esgotado:40,timeout:6 desativados=1289");
  assert.deepEqual(fs.readdirSync(dir), [STOCK_SUMMARY_FILE], "sem ficheiros temporários deixados");
});
check("ficheiro ausente: estado ausente, tanto no leitor como no script", () => {
  const dir = tmp();
  assert.deepEqual(readStockSyncSummary(dir), { status: "ausente" });
  assert.equal(imprimir(dir), "SSS: estado=ausente");
});
check("ficheiro adulterado: SKU, handle, chave a mais, causa livre ou contagem enorme tornam-no inválido", () => {
  const base = { v: 1, ranAt: "2026-11-07T10:30:00.000Z", checked: 10, found: 9, notFound: 0, error: 1, errorByCause: { timeout: 1 }, desativados: 0 };
  const adulterados = {
    "chave sku": { ...base, sku: "8435450233067" },
    "chave handle": { ...base, handle: "darth-vader" },
    "causa livre": { ...base, errorByCause: { darth_vader: 1 } },
    "causa com texto no valor": { ...base, errorByCause: { timeout: "8435450233067" } },
    "contagem com 13 dígitos": { ...base, checked: 8435450233067 },
    "contagem negativa": { ...base, found: -1 },
    "contagem fracionária": { ...base, found: 1.5 },
    "data com texto": { ...base, ranAt: "gid://shopify/Product/1" },
    "soma das causas diferente do total": { ...base, error: 5 },
    "versão desconhecida": { ...base, v: 2 },
    "chave em falta": (({ desativados, ...resto }) => resto)(base),
  };
  for (const [nome, obj] of Object.entries(adulterados)) {
    assert.equal(validateStockSyncSummary(obj), null, nome);
    const dir = tmp();
    fs.writeFileSync(path.join(dir, STOCK_SUMMARY_FILE), JSON.stringify(obj));
    assert.deepEqual(readStockSyncSummary(dir), { status: "invalido" }, nome);
    assert.equal(imprimir(dir), "SSS: estado=invalido", nome);
  }
});
check("ficheiro adulterado que não é JSON: inválido, e o script não imprime o conteúdo", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, STOCK_SUMMARY_FILE), "SKU 8435450233067 darth-vader {{{");
  assert.deepEqual(readStockSyncSummary(dir), { status: "invalido" });
  assert.equal(imprimir(dir), "SSS: estado=invalido");
});
check("o escritor recusa um resumo inválido e não cria o ficheiro", () => {
  const dir = tmp();
  assert.equal(writeStockSyncSummary(dir, { ...buildStockSyncSummary(RESULT, 0), sku: "123" }), false);
  assert.equal(fs.existsSync(path.join(dir, STOCK_SUMMARY_FILE)), false);
});
check("causas fora da lista fixa não entram no resumo montado", () => {
  const r = buildStockSyncSummary({ checked: 3, lookup: { found: 1, notFound: 0, errorByCause: { timeout: 1, handle_x: 5 } } }, 0);
  assert.deepEqual(r.errorByCause, { timeout: 1 });
  assert.equal(r.error, 1);
});
check("o teto de uma contagem é 7 dígitos, abaixo de qualquer SKU ou EAN", () => {
  assert.equal(STOCK_SUMMARY_MAX_COUNT, 9_999_999);
  assert.equal(String(STOCK_SUMMARY_MAX_COUNT).length, 7);
});
check("o ciclo grava o resumo depois de desativar os antigos, sem deixar o ciclo falhar (estático)", () => {
  const src = fs.readFileSync(path.join(ROOT, "app/routes/api.trigger-sync.jsx"), "utf8");
  const i = src.indexOf("desativados = await clearNotFoundErrorsForSkus");
  const j = src.indexOf("writeStockSyncSummary(resolveCurationDataDir(), buildStockSyncSummary(stockResult, desativados))");
  assert.ok(i > 0 && j > i, "a gravação tem de vir depois da desativação");
  assert.match(src.slice(j - 40, j + 260), /catch \(err\)/);
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nstock-sync-summary: todos os testes passaram");
