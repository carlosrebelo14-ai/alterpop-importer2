import { PrismaClient } from "@prisma/client";
import { configureSqliteForPrisma } from "../lib/prisma/configureSqlite.server.js";

const PRISMA_WATCHDOG_MS = 5 * 60 * 1000;

function createPrismaClient() {
  return new PrismaClient({
    log: process.env.PRISMA_LOG === "1" ? ["warn", "error"] : [],
  });
}

/** Recria o cliente em dev se o schema mudou (ex.: novos modelos CatalogProduct). */
function resolvePrisma() {
  const existing = global.prismaGlobal;
  if (existing?.catalogProduct && existing?.catalogProductFilterTag) {
    return existing;
  }

  const client = createPrismaClient();
  global.prismaGlobal = client;
  return client;
}

const prisma = resolvePrisma();

/**
 * Aplica WAL/busy_timeout na primeira ligação e após reconnect.
 */
async function bootstrapSqlitePragmas(client) {
  try {
    await configureSqliteForPrisma(client);
    if (!global.__alterpopSqlitePragmasLogged) {
      global.__alterpopSqlitePragmasLogged = true;
      console.log("[prisma] SQLite WAL + busy_timeout activos");
    }
  } catch (err) {
    console.error(`[prisma] Falha ao configurar PRAGMAs SQLite: ${err?.message || err}`);
  }
}

void bootstrapSqlitePragmas(prisma);

/**
 * Watchdog de ligação (não substitui ping HTTP externo a /api/health).
 * Recupera de "database is locked" ou ligações stale após reinício do host.
 */
function startPrismaConnectionWatchdog() {
  if (global.__alterpopPrismaWatchdogStarted) return;
  global.__alterpopPrismaWatchdogStarted = true;

  const ping = async () => {
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      console.error(`[prisma] watchdog falhou: ${err?.message || err}`);
      try {
        await prisma.$disconnect();
        await prisma.$connect();
        await configureSqliteForPrisma(prisma);
        console.log("[prisma] ligação restabelecida (watchdog)");
      } catch (reconnectErr) {
        console.error(`[prisma] reconnect falhou: ${reconnectErr?.message || reconnectErr}`);
      }
    }
  };

  ping();
  const timer = setInterval(ping, PRISMA_WATCHDOG_MS);
  timer.unref?.();
}

startPrismaConnectionWatchdog();

export default prisma;
