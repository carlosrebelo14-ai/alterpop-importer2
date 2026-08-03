import fs from "fs";
import { PrismaClient } from "@prisma/client";

const dbPath = process.env.DATABASE_URL?.replace(/^file:/, "") || "/app/data/dev.sqlite";

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

/** Backup antes de apagar; aborta sem apagar nada se o backup falhar. */
function backupAndRemove(files) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backedUp = [];

  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    try {
      fs.copyFileSync(f, `${f}.corrupt-${timestamp}.bak`);
      backedUp.push(f);
    } catch (backupErr) {
      console.error(
        `[db-check] Falha ao fazer backup de ${f} — reparação ABORTADA (nada foi apagado):`,
        backupErr?.message || backupErr
      );
      return false;
    }
  }

  for (const f of backedUp) {
    try {
      fs.unlinkSync(f);
    } catch (unlinkErr) {
      console.error(`[db-check] Falha ao apagar ${f} após backup:`, unlinkErr?.message || unlinkErr);
    }
  }

  console.log(`[db-check] Backup guardado com sufixo .corrupt-${timestamp}.bak (+ wal/shm)`);
  return true;
}

async function checkAndRepairDb() {
  const prisma = new PrismaClient();
  try {
    await prisma.$queryRawUnsafe("PRAGMA quick_check;");
    await prisma.catalogProduct.count();
    console.log("[db-check] Database integrity OK.");
  } catch (err) {
    if (isRealSqliteCorruption(err)) {
      console.warn("[db-check] Corrupção SQLite confirmada — a fazer backup e recriar...");
      await prisma.$disconnect().catch(() => {});
      const targets = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
      backupAndRemove(targets);
    } else {
      console.warn(
        `[db-check] Erro ao verificar integridade (não é corrupção SQLite confirmada, BD mantida): ${err?.message || err}`
      );
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

checkAndRepairDb().catch(console.error);
