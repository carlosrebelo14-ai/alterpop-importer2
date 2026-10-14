#!/usr/bin/env node
/**
 * Decisão 34 (DBG-02) — verificação de integridade no arranque.
 * Em corrupção: não apaga, grava a flag DB_DEGRADED e sai com 0 (sem crash-loop).
 * Uso: node scripts/tests/ensure-clean-db.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const script = path.join(root, "scripts/setup/ensure-clean-db.js");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ensure-clean-db-"));
}

function runEnsure(dbFile) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
    encoding: "utf8",
    timeout: 120000,
  });
}

console.log("ensure-clean-db — DBG-02");

check("BD corrompida: sai com 0, não apaga o ficheiro e grava a flag", () => {
  const dir = freshDir();
  const db = path.join(dir, "dev.sqlite");
  const garbage = Buffer.from("isto não é uma base de dados SQLite\n".repeat(64));
  fs.writeFileSync(db, garbage);

  const r = runEnsure(db);
  assert.equal(r.status, 0, `esperado 0 (sem crash-loop), veio ${r.status}: ${r.stderr}`);
  assert.ok(fs.existsSync(db), "o ficheiro foi apagado");
  assert.ok(fs.readFileSync(db).equals(garbage), "o ficheiro foi alterado");

  const flag = path.join(dir, "DB_DEGRADED");
  assert.ok(fs.existsSync(flag), "a flag não foi gravada");
  const state = JSON.parse(fs.readFileSync(flag, "utf8"));
  assert.match(state.cause, /cabeçalho SQLite inválido|corrupção SQLite/);
  assert.ok(state.at, "falta a data");
  assert.match(r.stdout + r.stderr, /Modo degradado ativo/);
});

check("cabeçalho inválido: WAL preservado (original e cópia) antes de qualquer abertura", () => {
  const dir = freshDir();
  const db = path.join(dir, "dev.sqlite");
  fs.writeFileSync(db, Buffer.from("lixo\n".repeat(200)));
  fs.writeFileSync(`${db}-wal`, Buffer.from("wal-content"));

  const r = runEnsure(db);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(`${db}-wal`), "o wal original foi apagado");
  assert.equal(fs.readFileSync(`${db}-wal`, "utf8"), "wal-content");
  const copies = fs.readdirSync(dir).filter((f) => f.startsWith("dev.sqlite-wal.corrupt-"));
  assert.equal(copies.length, 1, `esperada 1 cópia do WAL, vieram ${copies.length}`);
  assert.equal(fs.readFileSync(path.join(dir, copies[0]), "utf8"), "wal-content");
  const state = JSON.parse(fs.readFileSync(path.join(dir, "DB_DEGRADED"), "utf8"));
  assert.match(state.cause, /cabeçalho SQLite inválido/);
});

check("cabeçalho válido com páginas corrompidas: caminho do Prisma, flag e ficheiro intacto", () => {
  const dir = freshDir();
  const db = path.join(dir, "dev.sqlite");
  const r0 = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { PrismaClient } from "@prisma/client";
       const p = new PrismaClient();
       await p.$executeRawUnsafe("CREATE TABLE IF NOT EXISTS probe (x INTEGER)");
       await p.$executeRawUnsafe("INSERT INTO probe VALUES (1)");
       await p.$disconnect();`,
    ],
    { cwd: root, env: { ...process.env, DATABASE_URL: `file:${db}` }, encoding: "utf8", timeout: 120000 }
  );
  assert.equal(r0.status, 0, `criação da BD de teste falhou: ${r0.stderr}`);

  // Mantém o cabeçalho (16 bytes) e corrompe o resto das páginas.
  const bytes = fs.readFileSync(db);
  const garbled = Buffer.concat([bytes.subarray(0, 100), Buffer.alloc(bytes.length - 100, 0xff)]);
  fs.writeFileSync(db, garbled);

  const r = runEnsure(db);
  assert.equal(r.status, 0, `esperado 0, veio ${r.status}: ${r.stderr}`);
  assert.ok(fs.readFileSync(db).equals(garbled), "o ficheiro foi alterado");
  const flag = path.join(dir, "DB_DEGRADED");
  assert.ok(fs.existsSync(flag), "a corrupção de páginas não foi marcada");
  assert.match(JSON.parse(fs.readFileSync(flag, "utf8")).cause, /corrupção SQLite/);
});

check("BD íntegra: sai com 0, sem flag", () => {
  const dir = freshDir();
  const db = path.join(dir, "dev.sqlite");
  const r0 = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { PrismaClient } from "@prisma/client";
       const p = new PrismaClient();
       await p.$executeRawUnsafe("CREATE TABLE IF NOT EXISTS probe (x INTEGER)");
       await p.$disconnect();`,
    ],
    { cwd: root, env: { ...process.env, DATABASE_URL: `file:${db}` }, encoding: "utf8", timeout: 120000 }
  );
  assert.equal(r0.status, 0, `criação da BD de teste falhou: ${r0.stderr}`);

  const r = runEnsure(db);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(dir, "DB_DEGRADED")), "não devia haver flag numa BD íntegra");
});

check("o arranque não apaga ficheiros nem corre schema push", () => {
  const src = fs.readFileSync(script, "utf8");
  assert.ok(!/unlinkSync|rmSync|rmdirSync/.test(src), "o script ainda apaga ficheiros");
  assert.ok(!/db push/.test(src), "o script não corre schema push");
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
