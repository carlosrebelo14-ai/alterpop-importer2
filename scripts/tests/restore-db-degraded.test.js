#!/usr/bin/env node
/**
 * Decisão 34 (Lote 0) — script de saída do modo degradado.
 * Só apaga a flag com integrity_check = ok e com --execute.
 * Uso: node scripts/tests/restore-db-degraded.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const script = path.join(root, "scripts/setup/restore-db-degraded.js");

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "restore-degraded-"));
}

function run(args, dbFile, extraEnv = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: `file:${dbFile}`, ...extraEnv },
    encoding: "utf8",
    timeout: 120000,
  });
}

function registryWith(ref) {
  const file = path.join(freshDir(), "execucoes.md");
  fs.writeFileSync(file, `# Registo\n\n- ${ref}: teste\n`, "utf8");
  return file;
}

function makeHealthyDb(dbFile) {
  const r = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { PrismaClient } from "@prisma/client";
       const p = new PrismaClient();
       await p.$executeRawUnsafe("CREATE TABLE IF NOT EXISTS probe (x INTEGER)");
       await p.$disconnect();`,
    ],
    { cwd: root, env: { ...process.env, DATABASE_URL: `file:${dbFile}` }, encoding: "utf8", timeout: 120000 }
  );
  assert.equal(r.status, 0, `criação da BD saudável falhou: ${r.stderr}`);
}

console.log("restore-db-degraded");

check("sem flag, não faz nada e sai com 0", () => {
  const dir = freshDir();
  const db = path.join(dir, "dev.sqlite");
  makeHealthyDb(db);
  const r = run(["--execute"], db);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Nada a fazer/);
});

check("BD corrompida: sai com 1 e não apaga a flag", () => {
  const dir = freshDir();
  const db = path.join(dir, "dev.sqlite");
  fs.writeFileSync(db, Buffer.from("isto não é uma base de dados\n".repeat(64)));
  fs.writeFileSync(
    path.join(dir, "DB_DEGRADED"),
    JSON.stringify({ cause: "teste", at: "2026-10-14T00:00:00.000Z" }),
    "utf8"
  );
  const r = run(["--execute"], db);
  assert.equal(r.status, 1, `esperado 1, veio ${r.status}: ${r.stdout}${r.stderr}`);
  assert.ok(fs.existsSync(path.join(dir, "DB_DEGRADED")), "a flag não pode ser apagada sem integridade");
});

check("BD íntegra, sem --execute: dry-run, flag mantida", () => {
  const dir = freshDir();
  const db = path.join(dir, "dev.sqlite");
  makeHealthyDb(db);
  fs.writeFileSync(path.join(dir, "DB_DEGRADED"), JSON.stringify({ cause: "teste", at: null }), "utf8");
  const r = run([], db);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Dry-run/);
  assert.match(r.stdout, /integrity_check: ok/);
  assert.ok(fs.existsSync(path.join(dir, "DB_DEGRADED")));
});

check("BD íntegra, com --execute sem --ref: recusa, flag mantida", () => {
  const dir = freshDir();
  const db = path.join(dir, "dev.sqlite");
  makeHealthyDb(db);
  fs.writeFileSync(path.join(dir, "DB_DEGRADED"), JSON.stringify({ cause: "teste", at: null }), "utf8");
  const r = run(["--execute"], db, { EXECUCOES_PATH: registryWith("RESTORE-1") });
  assert.equal(r.status, 1, `esperado 1, veio ${r.status}`);
  assert.match(r.stderr, /exige --ref/);
  assert.ok(fs.existsSync(path.join(dir, "DB_DEGRADED")));
});

check("BD íntegra, --ref que não está no registo: recusa, flag mantida", () => {
  const dir = freshDir();
  const db = path.join(dir, "dev.sqlite");
  makeHealthyDb(db);
  fs.writeFileSync(path.join(dir, "DB_DEGRADED"), JSON.stringify({ cause: "teste", at: null }), "utf8");
  const r = run(["--execute", "--ref", "RESTORE-2"], db, { EXECUCOES_PATH: registryWith("RESTORE-1") });
  assert.equal(r.status, 1, `esperado 1, veio ${r.status}`);
  assert.match(r.stderr, /não está em docs\/execucoes.md/);
  assert.ok(fs.existsSync(path.join(dir, "DB_DEGRADED")));
});

check("BD íntegra, com --execute e --ref registado: flag apagada", () => {
  const dir = freshDir();
  const db = path.join(dir, "dev.sqlite");
  makeHealthyDb(db);
  fs.writeFileSync(path.join(dir, "DB_DEGRADED"), JSON.stringify({ cause: "teste", at: null }), "utf8");
  const r = run(["--execute", "--ref", "RESTORE-1"], db, { EXECUCOES_PATH: registryWith("RESTORE-1") });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(dir, "DB_DEGRADED")), "a flag devia ter sido apagada");
});

if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
