import { prisma, safePrisma } from "../../prisma/prismaSafe.server.js";

/**
 * Histórico persistido de corridas de sync (item 16 do roadmap) — diferente de
 * shopifySyncJob.server.js, que só guarda o estado da corrida ATUAL (um ficheiro
 * sobrescrito a cada corrida, usado para a barra de progresso). Isto aqui é uma
 * linha por corrida, para poder mostrar "última corrida: X sucesso, Y falhas" e
 * consultar o histórico depois.
 * @param {string} jobId
 * @param {string} shop
 * @param {number} received
 */
export async function createSyncJobRecord(jobId, shop, received) {
  return safePrisma("syncJob.create", () =>
    prisma.syncJob.create({
      data: { id: jobId, shop, received, status: "running" },
    })
  );
}

/**
 * @param {string} jobId
 * @param {{ succeeded: number, failed: number, status: 'completed'|'failed' }} summary
 */
export async function finishSyncJobRecord(jobId, summary) {
  return safePrisma("syncJob.finish", () =>
    prisma.syncJob.update({
      where: { id: jobId },
      data: {
        succeeded: summary.succeeded,
        failed: summary.failed,
        status: summary.status,
        finishedAt: new Date(),
      },
    }),
    { fallback: null }
  );
}

/**
 * @param {string} shop
 * @param {number} [limit]
 */
export async function listRecentSyncJobs(shop, limit = 20) {
  return safePrisma("syncJob.list", () =>
    prisma.syncJob.findMany({
      where: { shop },
      orderBy: { startedAt: "desc" },
      take: limit,
    }),
    { fallback: [] }
  );
}
