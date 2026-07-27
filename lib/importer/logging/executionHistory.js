import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.join(__dirname, "..", "..", "..", "logs", "execution-history.log");

/** @typedef {'importado' | 'atualizado' | 'rejeitado'} ExecutionAction */

/**
 * Registo de auditoria para o gestor da loja (append-only).
 * Formato: timestamp | SKU | acção | motivo_curadoria | jobId
 *
 * @param {{
 *   sku: string,
 *   action: ExecutionAction,
 *   reason?: string | string[],
 *   jobId?: string,
 * }} entry
 */
export async function logExecution({ sku, action, reason, jobId }) {
  const reasonText = Array.isArray(reason)
    ? reason.filter(Boolean).join(",")
    : reason || "-";

  const line = [
    new Date().toISOString(),
    sku,
    action,
    String(reasonText).replace(/\t/g, " ").slice(0, 500),
    jobId || "",
  ].join("\t");

  await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
  await fs.appendFile(LOG_PATH, `${line}\n`, "utf8");
}

/**
 * @param {object} entry
 * @param {string} [entry.action]
 * @param {string} [entry.type]
 * @param {string} [entry.shopifyStatus]
 * @param {string[]} [entry.curationReasons]
 * @param {string} [entry.reason]
 */
export function mapSuccessToExecutionAction(entry) {
  if (entry.shopifyStatus === "DRAFT") return "rejeitado";
  if (entry.action === "created" || entry.action === "dry_run_upsert") return "importado";
  if (entry.action === "updated") return "atualizado";
  return "atualizado";
}

export { LOG_PATH };
