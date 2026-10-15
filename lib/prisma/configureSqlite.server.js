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
  await client.$queryRawUnsafe("PRAGMA cache_size=-64000;");
  await client.$queryRawUnsafe("PRAGMA temp_store=MEMORY;");
}

/**
 * Época de ligação (DBG-15, relatório de 14/10/2026). O código da app sobe a época sempre que
 * fecha ou reabre o cliente. Antes da query seguinte, as PRAGMAs voltam a aplicar-se.
 *
 * Limite medido em 15/10 (Prisma 6, SQLite): o motor usa um pool de ligações. Com 40 leituras
 * paralelas depois de um SET busy_timeout=7777, 18 viram 7777 e 22 viram 5000. As PRAGMAs de
 * ligação (busy_timeout, synchronous, cache_size, temp_store) ficam só na ligação que as
 * recebeu. Este módulo garante a ligação que a query seguinte usa depois de uma reabertura.
 * Para todas as ligações do pool é preciso connection_limit=1, que muda a concorrência da app
 * (ver relatório de PR 2a, decisão do arquiteto).
 */
let epocaLigacao = 0;
/** cliente → época em que as PRAGMAs lhe foram aplicadas por último. */
const aplicadaPorCliente = new WeakMap();

/** Chamar depois de cada $disconnect/reconexão feita pelo código da app. */
export function marcarNovaLigacaoSqlite() {
  epocaLigacao += 1;
}

/**
 * Aplica as PRAGMAs ao cliente se a época atual ainda não lhe tiver sido aplicada. Devolve true
 * se aplicou. Se falhar, a época continua por aplicar e a query seguinte tenta de novo.
 * @param {{ $queryRawUnsafe: (sql: string) => Promise<unknown> }} client cliente SEM as extensões
 *   da app (as PRAGMAs passariam pelos próprios hooks)
 * @returns {Promise<boolean>}
 */
export async function garantirPragmasSqlite(client) {
  const aplicada = aplicadaPorCliente.get(client) ?? -1;
  if (aplicada === epocaLigacao) return false;
  const epoca = epocaLigacao;
  await configureSqliteForPrisma(client);
  aplicadaPorCliente.set(client, epoca);
  return true;
}
