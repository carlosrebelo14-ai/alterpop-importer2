/**
 * D1 (PR D, briefing 06/11/2026). Último resumo C8 do ciclo de stock dos publicados, em ficheiro no diretório de
 * dados. O buffer de logs da Fly cobre cerca de 10 minutos e o ciclo corre a cada cerca de 45, por isso o resumo
 * não pode depender dos logs. Só números e as causas fixas de LOOKUP_ERROR_CAUSES. Nunca SKUs, handles nem texto.
 *
 * O leitor valida tudo. Qualquer chave a mais, causa fora da lista, valor que não seja inteiro pequeno ou data fora
 * de formato torna o ficheiro inválido e nada dele é mostrado.
 */
import fs from "node:fs";
import path from "node:path";
import { LOOKUP_ERROR_CAUSES } from "../lib/resolveSku.js";

export const STOCK_SUMMARY_FILE = "stock-sync-summary.json";
export const STOCK_SUMMARY_VERSION = 1;
/** Maior valor aceite em qualquer contagem. Um SKU ou EAN tem 8 ou mais dígitos e nunca passa. */
export const STOCK_SUMMARY_MAX_COUNT = 9_999_999;

const CHAVES = ["v", "ranAt", "checked", "found", "notFound", "error", "errorByCause", "desativados"];
const CAUSAS = new Set(Object.values(LOOKUP_ERROR_CAUSES));
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const inteiro = (n) => Number.isInteger(n) && n >= 0 && n <= STOCK_SUMMARY_MAX_COUNT;

/**
 * Valida um objeto lido do disco. Devolve uma cópia limpa, ou null.
 * @param {unknown} obj
 * @returns {{ v: number, ranAt: string, checked: number, found: number, notFound: number, error: number, errorByCause: Record<string, number>, desativados: number } | null}
 */
export function validateStockSyncSummary(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = /** @type {Record<string, any>} */ (obj);
  const chaves = Object.keys(o);
  if (chaves.length !== CHAVES.length || !CHAVES.every((k) => chaves.includes(k))) return null;
  if (o.v !== STOCK_SUMMARY_VERSION) return null;
  if (typeof o.ranAt !== "string" || !ISO.test(o.ranAt) || Number.isNaN(Date.parse(o.ranAt))) return null;
  for (const k of ["checked", "found", "notFound", "error", "desativados"]) if (!inteiro(o[k])) return null;
  const causas = o.errorByCause;
  if (!causas || typeof causas !== "object" || Array.isArray(causas)) return null;
  const limpas = {};
  let soma = 0;
  for (const [k, v] of Object.entries(causas)) {
    if (!CAUSAS.has(k) || !inteiro(v)) return null;
    limpas[k] = v;
    soma += v;
  }
  if (soma !== o.error) return null;
  return { v: o.v, ranAt: o.ranAt, checked: o.checked, found: o.found, notFound: o.notFound, error: o.error, errorByCause: limpas, desativados: o.desativados };
}

/**
 * Monta o resumo a partir do resultado do ciclo de stock. Só copia contagens.
 * @param {{ checked: number, lookup: { found: number, notFound: number, errorByCause: Record<string, number> } }} result
 * @param {number} desativados erros "não encontrado" antigos desativados (C6)
 * @param {Date} [agora]
 */
export function buildStockSyncSummary(result, desativados, agora = new Date()) {
  const causas = {};
  let error = 0;
  for (const [k, v] of Object.entries(result.lookup.errorByCause || {})) {
    if (!CAUSAS.has(k)) continue;
    causas[k] = Number(v) || 0;
    error += causas[k];
  }
  return {
    v: STOCK_SUMMARY_VERSION,
    ranAt: agora.toISOString(),
    checked: result.checked,
    found: result.lookup.found,
    notFound: result.lookup.notFound,
    error,
    errorByCause: causas,
    desativados: Number(desativados) || 0,
  };
}

/**
 * Grava o resumo de forma atómica (ficheiro temporário e rename). Recusa um resumo que não passe a validação.
 * @param {string} dir
 * @param {ReturnType<typeof buildStockSyncSummary>} summary
 * @returns {boolean} true se gravou
 */
export function writeStockSyncSummary(dir, summary) {
  const limpo = validateStockSyncSummary(summary);
  if (!limpo) return false;
  const destino = path.join(dir, STOCK_SUMMARY_FILE);
  const tmp = `${destino}.${process.pid}.tmp`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(limpo), "utf8");
  fs.renameSync(tmp, destino);
  return true;
}

/**
 * @param {string} dir
 * @returns {{ status: 'ok', summary: NonNullable<ReturnType<typeof validateStockSyncSummary>> } | { status: 'ausente' } | { status: 'invalido' }}
 */
export function readStockSyncSummary(dir) {
  let texto;
  try {
    texto = fs.readFileSync(path.join(dir, STOCK_SUMMARY_FILE), "utf8");
  } catch (err) {
    return err?.code === "ENOENT" ? { status: "ausente" } : { status: "invalido" };
  }
  let obj;
  try {
    obj = JSON.parse(texto);
  } catch {
    return { status: "invalido" };
  }
  const summary = validateStockSyncSummary(obj);
  return summary ? { status: "ok", summary } : { status: "invalido" };
}
