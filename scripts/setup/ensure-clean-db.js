import fs from "fs";
import { PrismaClient } from "@prisma/client";
import { dbFilePath, markDbDegraded } from "../../lib/health/dbDegraded.js";

/**
 * Verificação de integridade no arranque do contentor (Decisão 34, DBG-02).
 *
 * Não apaga a BD. Em corrupção confirmada grava a flag DB_DEGRADED ao lado da BD e sai
 * com 0: a app arranca em modo degradado (sem escritas, com banner) em vez de entrar em
 * crash-loop. O restauro é um passo separado e aprovado (scripts/setup/restore-db-degraded.js).
 *
 * O motor do SQLite apaga o -wal ao abrir um ficheiro principal que não é SQLite. Por
 * isso, com cabeçalho inválido, o -wal e o -shm são copiados antes de qualquer abertura.
 */

const dbPath = dbFilePath();
const SQLITE_HEADER = "SQLite format 3\u0000";

/**
 * Cabeçalho inválido com o ficheiro presente: copia o -wal e o -shm para `.corrupt-<data>`
 * e devolve a lista de cópias. Não toca no ficheiro principal.
 * @returns {string[] | null} null se o cabeçalho é válido ou o ficheiro não existe
 */
function preserveSidecarsIfHeaderInvalid() {
  if (!fs.existsSync(dbPath)) return null;
  const head = Buffer.alloc(16);
  const fd = fs.openSync(dbPath, "r");
  try {
    fs.readSync(fd, head, 0, 16, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (head.toString("latin1") === SQLITE_HEADER) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const copies = [];
  for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!fs.existsSync(sidecar)) continue;
    const dest = `${sidecar}.corrupt-${stamp}`;
    fs.copyFileSync(sidecar, dest);
    copies.push(dest);
  }
  return copies;
}

/**
 * Strings/códigos canónicos de corrupção real do ficheiro SQLite — não basta a
 * mensagem "conter" a palavra corrupt/malformed (mesmo padrão restrito já
 * aplicado em lib/prisma/prismaSafe.server.js).
 */
const SQLITE_CORRUPTION_PATTERNS = [
  /database disk image is malformed/i,
  /file is( not|n't) a database/i,
  /SQLITE_CORRUPT/,
];

function isRealSqliteCorruption(err) {
  const code = String(err?.code || err?.errorCode || "").toUpperCase();
  if (code.includes("SQLITE_CORRUPT")) return true;
  const message = err?.message || String(err);
  return SQLITE_CORRUPTION_PATTERNS.some((pattern) => pattern.test(message));
}

/** Grava a flag. Falha da flag sai com 1: sem flag a app não pode arrancar com escritas abertas. */
function markOrFailClosed(cause) {
  try {
    const state = markDbDegraded(cause);
    console.error(`[db-check] Modo degradado ativo desde ${state.at}. Causa: ${cause}. Ficheiro mantido intacto.`);
    return true;
  } catch (flagErr) {
    console.error(`[db-check] Não foi possível gravar a flag DB_DEGRADED: ${flagErr?.message || flagErr}`);
    process.exitCode = 1;
    return false;
  }
}

async function checkAndMarkDb() {
  let copies;
  try {
    copies = preserveSidecarsIfHeaderInvalid();
  } catch (err) {
    // Sem a cópia do WAL, abrir a BD pode apagá-lo. Não se abre.
    markOrFailClosed(`cabeçalho SQLite a verificar, cópia do WAL falhou (${err?.message || err})`);
    return;
  }
  if (copies) {
    const preserved = copies.length ? `WAL preservado em ${copies.join(", ")}` : "sem WAL para preservar";
    markOrFailClosed(`cabeçalho SQLite inválido no arranque; ${preserved}`);
    return;
  }

  const prisma = new PrismaClient();
  try {
    await prisma.$queryRawUnsafe("PRAGMA quick_check;");
    await prisma.catalogProduct.count();
    console.log("[db-check] Database integrity OK.");
  } catch (err) {
    if (isRealSqliteCorruption(err)) {
      const firstLine = String(err?.message || err).split("\n")[0];
      markOrFailClosed(`corrupção SQLite no arranque: ${firstLine}`);
    } else {
      console.warn(
        `[db-check] Erro ao verificar integridade (não é corrupção SQLite confirmada, BD mantida): ${err?.message || err}`
      );
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

checkAndMarkDb().catch((err) => {
  console.error("[db-check] Erro inesperado (BD não alterada):", err?.message || err);
});
