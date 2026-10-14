import fs from "fs";
import path from "path";

/**
 * Modo degradado da BD (Decisão 34, Lote 0).
 *
 * Em corrupção do SQLite a app não apaga nada. Grava a flag `DB_DEGRADED` ao lado do
 * ficheiro da BD (no volume, em produção) e passa a recusar escritas. Leituras continuam
 * a funcionar, para o painel mostrar a causa.
 *
 * Sem dependência de Prisma: é importado também por scripts/setup/ensure-clean-db.js,
 * que corre antes da app arrancar.
 */

export const DB_DEGRADED_FLAG = "DB_DEGRADED";

export class DbDegradedError extends Error {
  /**
   * @param {string} action operação que foi recusada
   * @param {{ cause: string, at: string | null }} state
   */
  constructor(action, state) {
    super(`BD em modo degradado (${state?.cause ?? "causa desconhecida"}). ${action} recusado. Ver docs/decisoes.md, Decisão 34.`);
    this.name = "DbDegradedError";
    this.code = "DB_DEGRADED";
    this.state = state;
  }
}

/** @param {NodeJS.ProcessEnv} [env] */
export function dbFilePath(env = process.env) {
  return (env.DATABASE_URL || "file:/app/data/dev.sqlite").replace(/^file:/, "");
}

/** @param {NodeJS.ProcessEnv} [env] */
export function dbDegradedFlagPath(env = process.env) {
  return path.join(path.dirname(dbFilePath(env)), DB_DEGRADED_FLAG);
}

/**
 * Estado atual, ou null se a BD está saudável.
 * Flag ilegível conta como degradado: na dúvida, bloqueia.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ cause: string, at: string | null } | null}
 */
export function readDbDegraded(env = process.env) {
  let raw;
  try {
    raw = fs.readFileSync(dbDegradedFlagPath(env), "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    return { cause: `flag ilegível (${err?.message || err})`, at: null };
  }
  try {
    const parsed = JSON.parse(raw);
    return { cause: String(parsed?.cause || "causa não registada"), at: parsed?.at ?? null };
  } catch {
    return { cause: "flag corrompida", at: null };
  }
}

/**
 * Grava a flag. Escrita atómica (tmp + rename), para não deixar meio ficheiro.
 * @param {string} cause
 * @param {NodeJS.ProcessEnv} [env]
 */
export function markDbDegraded(cause, env = process.env) {
  const file = dbDegradedFlagPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const state = { cause: String(cause), at: new Date().toISOString() };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return state;
}

/**
 * Copia o -wal e o -shm para `.corrupt-<data>` ao lado da BD. Não toca no ficheiro principal
 * e não apaga nada. Necessário antes de reabrir uma BD corrompida: o motor do SQLite apaga o
 * -wal ao abrir um ficheiro que não é SQLite.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]} cópias criadas (vazio se não havia -wal nem -shm)
 */
export function copySqliteSidecars(env = process.env) {
  const db = dbFilePath(env);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const copies = [];
  for (const sidecar of [`${db}-wal`, `${db}-shm`]) {
    if (!fs.existsSync(sidecar)) continue;
    const dest = `${sidecar}.corrupt-${stamp}`;
    fs.copyFileSync(sidecar, dest);
    copies.push(dest);
  }
  return copies;
}

/**
 * Lança DbDegradedError se a BD estiver degradada. Chamar antes de qualquer escrita.
 * @param {string} action
 * @param {NodeJS.ProcessEnv} [env]
 */
export function assertDbNotDegraded(action, env = process.env) {
  const state = readDbDegraded(env);
  if (state) throw new DbDegradedError(action, state);
}

/**
 * Remove a flag. Só o script de restauro chama isto, depois de integrity_check = ok.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function clearDbDegraded(env = process.env) {
  fs.rmSync(dbDegradedFlagPath(env), { force: true });
}
