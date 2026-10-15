#!/usr/bin/env node
/**
 * DBG-15 (relatório de 14/10/2026) · PRAGMAs SQLite depois de cada reabertura da ligação.
 *
 * Dois níveis:
 *   1. Lógica da época (lib/prisma/configureSqlite.server.js) com um cliente falso: aplica uma
 *      vez por época, não repete sem nova época, e volta a aplicar depois de marcar uma nova.
 *   2. Prisma real, com connection_limit=1 no URL de teste: depois de reconectarPrisma(), a
 *      primeira query já vê busy_timeout = SQLITE_BUSY_TIMEOUT_MS e journal_mode = wal.
 *      Com o pool por omissão isto não se prova: as PRAGMAs ficam só numa ligação do pool
 *      (medido em 15/10, ver o comentário em configureSqlite.server.js).
 *
 * Uso: node scripts/tests/sqlite-pragmas-per-connection.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SQLITE_BUSY_TIMEOUT_MS = "7777";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-pragmas-"));
process.env.DATABASE_URL = `file:${path.join(dir, "pragma.sqlite")}?connection_limit=1`;

const { garantirPragmasSqlite, marcarNovaLigacaoSqlite } = await import(
  "../../lib/prisma/configureSqlite.server.js"
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

const valor = (linhas) => String(Object.values(linhas[0])[0]);

async function main() {
  console.log("época de ligação (cliente falso)");

  await check("aplica uma vez por época; sem nova época não repete", async () => {
    const sqls = [];
    const falso = { $queryRawUnsafe: async (sql) => (sqls.push(sql), []) };
    assert.equal(await garantirPragmasSqlite(falso), true, "primeira vez aplica");
    assert.equal(sqls.length, 6, "seis PRAGMAs");
    assert.ok(sqls.includes("PRAGMA busy_timeout=7777;"), "respeita SQLITE_BUSY_TIMEOUT_MS");
    assert.equal(await garantirPragmasSqlite(falso), false, "mesma época não reaplica");
    assert.equal(sqls.length, 6);
  });

  await check("nova época (reconexão) volta a aplicar antes da próxima query", async () => {
    const sqls = [];
    const falso = { $queryRawUnsafe: async (sql) => (sqls.push(sql), []) };
    assert.equal(await garantirPragmasSqlite(falso), true, "cliente novo aplica");
    marcarNovaLigacaoSqlite();
    assert.equal(await garantirPragmasSqlite(falso), true, "depois de reconectar, aplica outra vez");
    assert.equal(sqls.length, 12, "seis PRAGMAs em cada época");
  });

  await check("o estado é por cliente: um cliente já configurado não impede o outro", async () => {
    const a = [];
    const b = [];
    const clienteA = { $queryRawUnsafe: async (sql) => (a.push(sql), []) };
    const clienteB = { $queryRawUnsafe: async (sql) => (b.push(sql), []) };
    await garantirPragmasSqlite(clienteA);
    assert.equal(await garantirPragmasSqlite(clienteB), true, "o segundo cliente tem de receber as PRAGMAs");
    assert.equal(b.length, 6);
  });

  await check("falha ao aplicar deixa a época por aplicar: a query seguinte tenta de novo", async () => {
    let falhar = true;
    const sqls = [];
    const falso = {
      $queryRawUnsafe: async (sql) => {
        if (falhar) throw new Error("database is locked");
        sqls.push(sql);
        return [];
      },
    };
    marcarNovaLigacaoSqlite();
    await assert.rejects(() => garantirPragmasSqlite(falso), /database is locked/);
    falhar = false;
    assert.equal(await garantirPragmasSqlite(falso), true, "tem de voltar a tentar, não dar a época por boa");
  });

  console.log("Prisma real (connection_limit=1)");
  const { default: prisma, reconectarPrisma } = await import("../../app/db.server.js");

  await check("primeira query já vê busy_timeout e WAL", async () => {
    await prisma.$queryRawUnsafe("SELECT 1");
    assert.equal(valor(await prisma.$queryRawUnsafe("PRAGMA busy_timeout")), "7777");
    assert.equal(valor(await prisma.$queryRawUnsafe("PRAGMA journal_mode")), "wal");
  });

  await check("depois de reconectarPrisma(), a primeira query volta a ver as PRAGMAs", async () => {
    await reconectarPrisma();
    assert.equal(valor(await prisma.$queryRawUnsafe("PRAGMA busy_timeout")), "7777");
    assert.equal(valor(await prisma.$queryRawUnsafe("PRAGMA journal_mode")), "wal");
  });

  await prisma.$disconnect().catch(() => {});

  if (failures) {
    console.error(`\n${failures} falha(s)`);
    process.exit(1);
  }
  console.log("\nsqlite-pragmas-per-connection: todos os casos passaram");
  process.exit(0);
}

main();
