#!/usr/bin/env node
/* eslint-env node */
/**
 * Decisão 5 do arquiteto: a purga de elite fica proibida em produção até ao PR 2b-2 (DBG-43).
 *
 * scripts/curation/elite-curation-purge.js sai com código 1 e uma mensagem com DBG-43 e PR 2b-2,
 * antes de ler ou escrever. Vale também em dry-run. O script corre num diretório temporário, com
 * CURATION_DATA_DIR e DATABASE_URL apontados para lá: a fila e a BD reais não são tocadas.
 * A função purgeEliteCatalog fica em lib/ (o PR 2b-2 precisa dela).
 *
 * Uso: node scripts/tests/elite-purge-bloqueada.test.js
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(RAIZ, "scripts", "curation", "elite-curation-purge.js");
const ELITE_LIB = path.join(RAIZ, "lib", "importer", "curation", "eliteCuration.server.js");

let falhas = 0;
function check(nome, fn) {
  try {
    fn();
    console.log(`  ok  ${nome}`);
  } catch (err) {
    falhas += 1;
    console.error(`FAIL  ${nome}\n      ${err.message}`);
  }
}

/** Corre o script com a fila e a BD num diretório temporário. Nada da loja real. */
function correr(args, dir) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      CURATION_DATA_DIR: dir,
      DATABASE_URL: `file:${path.join(dir, "dev.sqlite")}`,
      SHOP: "loja-teste.myshopify.com",
    },
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "elite-bloqueada-"));
/** Diretório novo por corrida: uma corrida que escreva não deixa rasto para a seguinte. */
let contador = 0;
function diretorioNovo() {
  contador += 1;
  const dir = path.join(tmp, `corrida-${contador}`);
  fs.mkdirSync(dir);
  return dir;
}

check("sem argumentos: código 1 e mensagem com DBG-43 e PR 2b-2", () => {
  const r = correr([], diretorioNovo());
  assert.equal(r.status, 1, `código de saída (sinal ${r.signal}): ${r.stderr}`);
  const saida = `${r.stdout}\n${r.stderr}`;
  assert.match(saida, /DBG-43/);
  assert.match(saida, /PR 2b-2/);
  assert.match(saida, /bloqueada até DBG-43, PR 2b-2/);
});

check("em dry-run também: código 1 e a mesma recusa", () => {
  const r = correr(["--dry-run"], diretorioNovo());
  assert.equal(r.status, 1, `código de saída (sinal ${r.signal}): ${r.stderr}`);
  assert.match(`${r.stdout}\n${r.stderr}`, /bloqueada até DBG-43, PR 2b-2/);
});

check("nada é lido nem escrito: o diretório da fila continua vazio", () => {
  const dir = diretorioNovo();
  correr([], dir);
  assert.deepEqual(fs.readdirSync(dir), [], "nenhum ficheiro da fila (nem a BD de teste) foi criado");
  correr(["--dry-run"], dir);
  assert.deepEqual(fs.readdirSync(dir), [], "nem em dry-run");
});

check("purgeEliteCatalog continua exportada em lib/ para o PR 2b-2", () => {
  const texto = fs.readFileSync(ELITE_LIB, "utf8");
  assert.match(texto, /export async function purgeEliteCatalog\(/);
});

fs.rmSync(tmp, { recursive: true, force: true });

if (falhas) {
  console.error(`\nelite-purge-bloqueada: ${falhas} verificação(ões) falharam`);
  process.exit(1);
}
console.log("\nelite-purge-bloqueada: a purga de elite está bloqueada até DBG-43");
