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
  const { rethrow = true, fallback } = opts;
  try {
    return await fn();
  } catch (err) {
    const code = err?.code || "UNKNOWN";
    const message = err?.message || String(err);
    console.error(`[prisma] ${label} falhou (${code}): ${message}`);
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
