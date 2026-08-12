import { prisma, safePrisma } from "../../prisma/prismaSafe.server.js";

/** @typedef {'invalid_image'|'duplicate_sku'|'rate_limit'|'metafield'|'validation'|'auth'|'api_error'} SyncErrorType */

/**
 * @param {string} [reason]
 * @param {string} [type]
 * @returns {{ errorType: SyncErrorType, label: string }}
 */
export function classifySyncError(reason, type) {
  const text = `${type || ""} ${reason || ""}`.toLowerCase();

  if (text.includes("invalid_image") || text.includes("image") || text.includes("media") || text.includes("url")) {
    return { errorType: "invalid_image", label: "Imagem Inválida" };
  }
  if (
    text.includes("duplicate") ||
    text.includes("already exists") ||
    text.includes("taken") ||
    (text.includes("sku") && text.includes("exist"))
  ) {
    return { errorType: "duplicate_sku", label: "SKU Duplicado" };
  }
  if (
    text.includes("401") ||
    text.includes("invalid api key") ||
    text.includes("access token") ||
    text.includes("unrecognized login") ||
    type === "auth"
  ) {
    return { errorType: "auth", label: "Autenticação Shopify" };
  }
  if (text.includes("429") || text.includes("rate") || text.includes("throttl")) {
    return { errorType: "rate_limit", label: "Limite de API" };
  }
  if (text.includes("metafield")) {
    return { errorType: "metafield", label: "Metafield em falta" };
  }
  if (type === "validation" || text.includes("validation")) {
    return { errorType: "validation", label: "Validação" };
  }
  return { errorType: "api_error", label: "Erro de API" };
}

/**
 * @param {{
 *   shop: string,
 *   sku: string,
 *   reason: string,
 *   type?: string,
 *   jobId?: string,
 * }} entry
 */
export async function persistSyncError(entry) {
  if (!entry.shop || !entry.sku) return;

  const { errorType, label } = classifySyncError(entry.reason, entry.type);
  const message = String(entry.reason || label).slice(0, 2000);

  await safePrisma("syncErrorLog.create", () =>
    prisma.syncErrorLog.create({
      data: {
        shop: entry.shop,
        sku: entry.sku,
        errorType,
        message,
        jobId: entry.jobId || null,
      },
    })
  );

  return { errorType, label, message };
}

/**
 * @param {string} shop
 * @param {number} [limit]
 */
export async function listSyncErrors(shop, limit = 200) {
  const rows = await safePrisma("syncErrorLog.findMany", () =>
    prisma.syncErrorLog.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    { fallback: [] }
  );

  return rows.map((row) => {
    const { label } = classifySyncError(row.message, row.errorType);
    return {
      id: row.id,
      sku: row.sku,
      errorType: row.errorType,
      label,
      message: row.message,
      jobId: row.jobId,
      active: row.active,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

/**
 * Erros ATIVOS por SKU — usado para o "!" na lista de produtos. Filtra por active:true
 * para não mostrar uma mensagem de erro já resolvida/invalidada.
 * @param {string} shop
 * @param {string[]} skus
 */
export async function getSyncErrorsBySkus(shop, skus) {
  if (!skus.length) return {};
  const rows = await safePrisma("syncErrorLog.findMany", () =>
    prisma.syncErrorLog.findMany({
      where: { shop, sku: { in: skus }, active: true },
      orderBy: { createdAt: "desc" },
    }),
    { fallback: [] }
  );

  /** @type {Record<string, { label: string, message: string, errorType: string }>} */
  const map = {};
  for (const row of rows) {
    if (map[row.sku]) continue;
    const { label } = classifySyncError(row.message, row.errorType);
    map[row.sku] = { label, message: row.message, errorType: row.errorType };
  }
  return map;
}

/**
 * Resolvido — marca inativo em vez de apagar. Histórico fica disponível em
 * listSyncErrors() (página "Logs de Erro"); contagens de erros ativos (ex.:
 * getPollStats) já não o veem.
 * @param {string} shop
 * @param {string} sku
 */
export async function clearSyncErrorForSku(shop, sku) {
  await safePrisma("syncErrorLog.updateMany", () =>
    prisma.syncErrorLog.updateMany({
      where: { shop, sku, active: true },
      data: { active: false },
    })
  );
}

/**
 * Invalida em massa todos os erros ativos de uma loja — chamar depois de uma
 * reindexação/reset completo (não resumido), que reconstrói a fila de curadoria do
 * zero. Sem isto, SyncErrorLog acumulava erros de execuções antigas indefinidamente,
 * já que nenhuma reindexação alguma vez o tocava — dessincronizando com
 * curation-queue.json a cada reconstrução.
 * @param {string} shop
 */
export async function deactivateAllSyncErrors(shop) {
  await safePrisma("syncErrorLog.deactivateAll", () =>
    prisma.syncErrorLog.updateMany({
      where: { shop, active: true },
      data: { active: false },
    })
  );
}
