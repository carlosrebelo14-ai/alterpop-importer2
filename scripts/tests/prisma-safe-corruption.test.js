#!/usr/bin/env node
/**
 * Decisão 34 (DBG-01) — safePrisma em corrupção: sem apagão, sem db push, sem fallback.
 * Uso: node scripts/tests/prisma-safe-corruption.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prisma-safe-corrupt-"));
const db = path.join(tmp, "dev.sqlite");
process.env.DATABASE_URL = `file:${db}`;

const garbage = Buffer.from("lixo que não é SQLite\n".repeat(64));
fs.writeFileSync(db, garbage);
fs.writeFileSync(`${db}-wal`, Buffer.from("wal-content"));

const { safePrisma } = await import("../../lib/prisma/prismaSafe.server.js");
const { DbDegradedError, clearDbDegraded, dbDegradedFlagPath, readDbDegraded } = await import(
  "../../lib/health/dbDegraded.js"
);

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

const corruption = () => {
  throw Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" });
};

console.log("safePrisma — DBG-01");

await check("corrupção: lança erro visível mesmo com fallback (sem fallback silencioso)", async () => {
  clearDbDegraded();
  await assert.rejects(
    () => safePrisma("teste-corrupcao", corruption, { fallback: "X" }),
    (err) => err instanceof DbDegradedError && err.code === "DB_DEGRADED"
  );
});

await check("corrupção: grava a flag com a etiqueta da operação", () => {
  const state = readDbDegraded();
  assert.ok(state, "flag não gravada");
  assert.match(state.cause, /teste-corrupcao/);
  assert.equal(path.dirname(dbDegradedFlagPath()), tmp);
});

await check("corrupção: o ficheiro principal fica intacto", () => {
  assert.ok(fs.readFileSync(db).equals(garbage), "o ficheiro foi alterado");
});

await check("corrupção: o WAL original fica e é copiado", () => {
  assert.equal(fs.readFileSync(`${db}-wal`, "utf8"), "wal-content");
  const copies = fs.readdirSync(tmp).filter((f) => f.startsWith("dev.sqlite-wal.corrupt-"));
  assert.equal(copies.length, 1, `esperada 1 cópia, vieram ${copies.length}`);
  assert.equal(fs.readFileSync(path.join(tmp, copies[0]), "utf8"), "wal-content");
});

await check("erro sem corrupção mantém o comportamento antigo: fallback e sem flag", async () => {
  clearDbDegraded();
  const value = await safePrisma("teste-timeout", async () => {
    throw new Error("timeout de teste");
  }, { fallback: 7 });
  assert.equal(value, 7);
  assert.equal(readDbDegraded(), null, "não devia haver flag");
});

await check("erro sem corrupção com rethrow continua a propagar", async () => {
  await assert.rejects(
    () =>
      safePrisma("teste-rethrow", async () => {
        throw new Error("outro erro");
      }, { rethrow: true }),
    /outro erro/
  );
});

await check("prismaSafe não apaga, não copia o schema e não corre db push", () => {
  const src = fs.readFileSync(path.join(root, "lib/prisma/prismaSafe.server.js"), "utf8");
  assert.ok(!/unlinkSync|rmSync/.test(src), "o módulo ainda apaga ficheiros");
  assert.ok(!/execSync|child_process/.test(src), "o módulo ainda corre comandos");
  assert.ok(!/db push/.test(src), "o módulo ainda corre schema push");
});

clearDbDegraded();
if (failures) {
  console.error(`\n${failures} falha(s)`);
  process.exit(1);
}
console.log("\nTodos os testes passaram.");
process.exit(0);
