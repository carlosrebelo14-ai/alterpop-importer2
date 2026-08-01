import prisma from "../../app/db.server.js";

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

    if (message.includes("malformed") || message.includes("corrupt")) {
      console.warn(`[prisma] SQLite malformed detectado em "${label}". A restaurar ficheiro de base de dados...`);
      try {
        const { execSync } = await import("child_process");
        const fs = await import("fs");
        const dbPath = process.env.DATABASE_URL?.replace(/^file:/, "") || "/app/data/dev.sqlite";
        await prisma.$disconnect().catch(() => {});
        for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
          try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
        }
        execSync("npx prisma db push --skip-generate", { stdio: "ignore" });
        console.log("[prisma] Base de dados restaurada com sucesso.");
      } catch (repairErr) {
        console.error("[prisma] Falha ao auto-reparar SQLite:", repairErr?.message || repairErr);
      }
    }

    if (rethrow) throw err;
    return /** @type {T} */ (fallback);
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
