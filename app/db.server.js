import { PrismaClient } from "@prisma/client";
import { garantirPragmasSqlite, marcarNovaLigacaoSqlite } from "../lib/prisma/configureSqlite.server.js";
import { assertDbNotDegraded } from "../lib/health/dbDegraded.js";

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

const baseClient = resolvePrisma();

/**
 * PRAGMAs antes de cada operação, quando a época de ligação mudou (DBG-15). Usa o cliente base:
 * as PRAGMAs passariam de novo pelos hooks deste cliente.
 */
async function assegurarPragmas() {
  try {
    await garantirPragmasSqlite(baseClient);
  } catch (err) {
    console.error(`[prisma] Falha ao configurar PRAGMAs SQLite: ${err?.message || err}`);
  }
}

/**
 * Modo degradado (Decisão 34): escritas recusadas com DbDegradedError enquanto a flag
 * DB_DEGRADED existir. Leituras passam, para o painel mostrar a causa. Cobre os modelos
 * (create, update, delete, upsert e variantes) e as escritas SQL raw.
 */
const WRITE_MODEL_OPERATION = /^(create|update|delete|upsert)/i;
const WRITE_SQL = /^\s*(insert|update|delete|replace|create|drop|alter|vacuum|reindex)\b/i;
const prisma = baseClient.$extends({
  query: {
    async $allOperations({ operation, args, query }) {
      if (WRITE_MODEL_OPERATION.test(operation)) assertDbNotDegraded(`escrita na BD (${operation})`);
      await assegurarPragmas();
      return query(args);
    },
    async $queryRaw({ args, query }) {
      await assegurarPragmas();
      return query(args);
    },
    async $executeRaw({ args, query }) {
      assertDbNotDegraded("escrita SQL raw");
      await assegurarPragmas();
      return query(args);
    },
    async $executeRawUnsafe({ args, query }) {
      assertDbNotDegraded("escrita SQL raw");
      await assegurarPragmas();
      return query(args);
    },
    // $queryRawUnsafe é leitura por desenho, mas aceita SQL de escrita. Bloqueia-se essa forma.
    async $queryRawUnsafe({ args, query }) {
      const sql = Array.isArray(args) ? args[0] : args;
      if (WRITE_SQL.test(String(sql ?? ""))) assertDbNotDegraded("escrita SQL via queryRaw");
      await assegurarPragmas();
      return query(args);
    },
  },
});

/** Primeira aplicação, ao carregar o módulo. Depois, cada operação confirma a época. */
void assegurarPragmas().then(() => {
  if (!global.__alterpopSqlitePragmasLogged) {
    global.__alterpopSqlitePragmasLogged = true;
    console.log("[prisma] SQLite WAL + busy_timeout activos");
  }
});

/**
 * Fecha e reabre o cliente. A época sobe antes da próxima query, para que essa query volte a
 * aplicar as PRAGMAs (DBG-15: antes, só a reconexão do watchdog as aplicava, e uma ligação
 * reaberta por query implícita ficava sem WAL nem busy_timeout).
 */
export async function reconectarPrisma() {
  await prisma.$disconnect();
  marcarNovaLigacaoSqlite();
  await prisma.$connect();
}

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
        await reconectarPrisma();
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
