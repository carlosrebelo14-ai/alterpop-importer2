/**
 * PRAGMAs SQLite — WAL + busy_timeout para concorrência e menos "database is locked".
 * @param {import('@prisma/client').PrismaClient} client
 */
export async function configureSqliteForPrisma(client) {
  const busyMs = Number.parseInt(process.env.SQLITE_BUSY_TIMEOUT_MS || "5000", 10);
  const busyTimeout = Number.isFinite(busyMs) && busyMs > 0 ? busyMs : 5000;

  // PRAGMA query devolve resultados no SQLite; usar queryRawUnsafe para evitar erro no Prisma executeRaw
  await client.$queryRawUnsafe("PRAGMA journal_mode=WAL;");
  await client.$queryRawUnsafe(`PRAGMA busy_timeout=${busyTimeout};`);
  await client.$queryRawUnsafe("PRAGMA synchronous=NORMAL;");
  await client.$queryRawUnsafe("PRAGMA foreign_keys=ON;");
}
