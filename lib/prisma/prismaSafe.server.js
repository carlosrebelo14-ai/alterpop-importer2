import prisma from "../../app/db.server.js";

/**
 * Strings/códigos canónicos devolvidos pelo motor SQLite em caso de corrupção real
 * do ficheiro. Não basta a mensagem "conter" a palavra corrupt/malformed — isso
 * apanhava falsos positivos de erros de aplicação sem relação com o ficheiro .sqlite.
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

/**
 * Executa operação Prisma com try/catch e log estruturado.
 * @template T
 * @param {string} label
 * @param {() => Promise<T>} fn
 * @param {{ rethrow?: boolean, fallback?: T }} [opts]
 * @returns {Promise<T>}
 */
export async function safePrisma(label, fn, opts = {}) {
  const { rethrow = false, fallback } = opts;
  try {
    return await fn();
  } catch (err) {
    const code = err?.code || "UNKNOWN";
    const message = err?.message || String(err);
    console.error(`[prisma] ${label} falhou (${code}): ${message}`);

    if (isRealSqliteCorruption(err)) {
      console.warn(`[prisma] Corrupção SQLite confirmada em "${label}". A fazer backup e restaurar...`);
      await backupAndRestoreDatabase();
    }

    if (rethrow) throw err;
    return /** @type {T} */ (fallback);
  }
}

/**
 * Faz backup dos ficheiros SQLite (db + wal + shm) antes de os apagar.
 * Se o backup de QUALQUER ficheiro falhar, aborta sem apagar nada.
 */
async function backupAndRestoreDatabase() {
  const fs = await import("fs");
  const { execSync } = await import("child_process");
  const dbPath = process.env.DATABASE_URL?.replace(/^file:/, "") || "/app/data/dev.sqlite";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];

  await prisma.$disconnect().catch(() => {});

  const backedUp = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    try {
      fs.copyFileSync(f, `${f}.corrupt-${timestamp}.bak`);
      backedUp.push(f);
    } catch (backupErr) {
      console.error(
        `[prisma] Falha ao fazer backup de ${f} — reparação automática ABORTADA (nada foi apagado):`,
        backupErr?.message || backupErr
      );
      return;
    }
  }

  for (const f of backedUp) {
    try {
      fs.unlinkSync(f);
    } catch (unlinkErr) {
      console.error(`[prisma] Falha ao apagar ${f} após backup:`, unlinkErr?.message || unlinkErr);
    }
  }

  try {
    execSync("npx prisma db push --skip-generate", { stdio: "ignore" });
    console.log(
      `[prisma] Base de dados restaurada com sucesso. Backup em ${dbPath}.corrupt-${timestamp}.bak (+ wal/shm)`
    );
  } catch (repairErr) {
    console.error("[prisma] Falha ao recriar schema após reparação:", repairErr?.message || repairErr);
  }
}

/**
 * Encerra o cliente Prisma (graceful shutdown).
 */
export async function disconnectPrisma() {
  await safePrisma("disconnect", () => prisma.$disconnect(), { rethrow: false });
}

if (!global.__alterpopPrismaShutdownHook) {
  global.__alterpopPrismaShutdownHook = true;
  const shutdown = () => {
    disconnectPrisma().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

export { prisma };
