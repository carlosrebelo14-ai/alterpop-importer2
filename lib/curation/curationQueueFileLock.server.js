/* eslint-env node */
/**
 * DBG-04, Decisão 35 (D1), decisão 1 do arquiteto. Lock de ficheiro entre processos para a fila de
 * curadoria.
 *
 * O lock em memória (withCurationQueueLock, em curationQueue.server.js) só protege um processo. Os
 * scripts que escrevem a fila correm noutro processo Node. Por isso a entrada mais externa de cada
 * processo toma também este lock de ficheiro, no caminho que o chamador indica (o ficheiro de lock
 * fica em CURATION_DATA_DIR).
 *
 * Formato: JSON { pid, em, token }. `em` é a hora da última renovação. O titular renova `em` a cada
 * renovação (60 s por omissão) enquanto segura o lock. O `token` identifica esta posse: só o titular
 * o liberta.
 *
 * Um lock é obsoleto, e um processo novo pode libertá-lo, quando:
 *   - o PID não existe (process.kill(pid, 0) devolve ESRCH), ou
 *   - a hora `em` é anterior ao arranque da máquina (um PID pode ser reutilizado depois de reinício), ou
 *   - a hora `em` tem mais de 10 min sem renovação.
 *
 * Quando o lock está ocupado e fresco, espera com repetição. Passado o prazo (30 s por omissão),
 * lança CurationQueueLockError: nunca se escreve sem o lock (fail closed).
 *
 * As variáveis CURATION_QUEUE_LOCK_PRAZO_MS, CURATION_QUEUE_LOCK_OBSOLETO_MS e
 * CURATION_QUEUE_LOCK_RENOVA_MS existem só para os testes. Lidas a cada chamada. Em produção ficam
 * por omissão.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const PRAZO_PADRAO_MS = 30_000;
const OBSOLETO_PADRAO_MS = 10 * 60_000;
const RENOVA_PADRAO_MS = 60_000;
const ESPERA_MIN_MS = 5;
const ESPERA_MAX_MS = 200;

export class CurationQueueLockError extends Error {
  /** @param {string} mensagem */
  constructor(mensagem) {
    super(mensagem);
    this.name = "CurationQueueLockError";
    this.code = "CURATION_QUEUE_LOCK_TIMEOUT";
  }
}

/** @param {string} nome @param {number} padrao */
function duracaoDeAmbiente(nome, padrao) {
  const valor = Number(process.env[nome]);
  return Number.isFinite(valor) && valor > 0 ? valor : padrao;
}

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Hora do arranque desta máquina, pelo uptime (como lib/curation/atividadeApp.js). */
const horaDoArranque = () => Date.now() - os.uptime() * 1000;

/** O PID existe se o sinal 0 não der ESRCH. Sem permissão (EPERM) o processo existe. */
function pidExiste(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== "ESRCH";
  }
}

/** @param {number} pid @param {string} token */
function conteudoDoLock(pid, token) {
  return JSON.stringify({ pid, em: new Date().toISOString(), token });
}

/**
 * Lê o lock. null se o ficheiro não existe. Conteúdo ilegível (escrita a meio) devolve campos nulos,
 * e a idade passa a ser a do mtime do ficheiro.
 * @param {string} lockPath
 */
async function lerLock(lockPath) {
  let raw;
  try {
    raw = await fs.readFile(lockPath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  try {
    const dados = JSON.parse(raw);
    return {
      raw,
      pid: Number.isInteger(dados?.pid) && dados.pid > 0 ? dados.pid : null,
      em: typeof dados?.em === "string" ? dados.em : null,
      token: typeof dados?.token === "string" ? dados.token : null,
    };
  } catch {
    return { raw, pid: null, em: null, token: null };
  }
}

/**
 * @param {string} lockPath
 * @param {{ pid: number | null, em: string | null }} lock
 * @param {number} obsoletoMs
 */
async function estaObsoleto(lockPath, lock, obsoletoMs) {
  if (lock.pid !== null && !pidExiste(lock.pid)) return true;
  let referencia = Date.parse(lock.em);
  if (!Number.isFinite(referencia)) {
    const stat = await fs.stat(lockPath).catch(() => null);
    if (!stat) return true;
    referencia = stat.mtimeMs;
  }
  // Escrito antes do arranque: é de um processo que já não existe, mesmo que o PID esteja vivo.
  if (referencia < horaDoArranque()) return true;
  return Date.now() - referencia > obsoletoMs;
}

/**
 * Remove o lock se estiver obsoleto. Só remove o conteúdo que foi lido: se outro processo o tiver
 * substituído entretanto, não se toca nele. Devolve true quando vale a pena tentar criar de novo.
 * @param {string} lockPath
 * @param {number} obsoletoMs
 */
async function libertarSeObsoleto(lockPath, obsoletoMs) {
  const lock = await lerLock(lockPath);
  if (lock === null) return true;
  if (!(await estaObsoleto(lockPath, lock, obsoletoMs))) return false;
  const agora = await lerLock(lockPath);
  if (agora?.raw !== lock.raw) return true;
  await fs.unlink(lockPath).catch((err) => {
    if (err?.code !== "ENOENT") throw err;
  });
  return true;
}

/**
 * Cria o lock com `wx`. Devolve o titular, ou null se o ficheiro já existe.
 * @param {string} lockPath
 */
async function tentarCriar(lockPath) {
  const token = randomUUID();
  let handle;
  try {
    handle = await fs.open(lockPath, "wx");
  } catch (err) {
    if (err?.code === "EEXIST") return null;
    throw err;
  }
  try {
    await handle.writeFile(conteudoDoLock(process.pid, token), "utf8");
  } catch (err) {
    await handle.close().catch(() => {});
    await fs.unlink(lockPath).catch(() => {});
    throw err;
  }
  await handle.close();
  const titular = { lockPath, token, timer: null, renovando: null, perdido: false };
  titular.timer = iniciarRenovacao(titular);
  return titular;
}

/** @param {{ lockPath: string, token: string, timer: any, perdido: boolean, renovando: Promise<void> | null }} titular */
async function renovar(titular) {
  const atual = await lerLock(titular.lockPath);
  // O ficheiro já não tem o token do titular: o lock foi tomado (obsoleto) ou removido. Não se
  // reescreve o lock de outro. O titular fica marcado como perdido e para de renovar. Entre esta
  // leitura e a escrita há uma janela curta, que só um titular parado mais de 10 min atinge.
  if (!atual || atual.token !== titular.token) {
    titular.perdido = true;
    clearInterval(titular.timer);
    return;
  }
  await fs.writeFile(titular.lockPath, conteudoDoLock(process.pid, titular.token), "utf8");
}

/** @param {{ lockPath: string, token: string, timer: any, renovando: Promise<void> | null }} titular */
function iniciarRenovacao(titular) {
  const intervaloMs = duracaoDeAmbiente("CURATION_QUEUE_LOCK_RENOVA_MS", RENOVA_PADRAO_MS);
  const timer = setInterval(() => {
    if (titular.renovando) return;
    titular.renovando = renovar(titular)
      .catch(() => {})
      .finally(() => {
        titular.renovando = null;
      });
  }, intervaloMs);
  timer.unref();
  return timer;
}

/**
 * Toma o lock de ficheiro. Espera enquanto estiver ocupado e fresco. Passado o prazo, lança
 * CurationQueueLockError sem tocar no ficheiro.
 * @param {string} lockPath
 * @returns {Promise<{ lockPath: string, token: string, timer: any, renovando: Promise<void> | null }>}
 */
export async function adquirirLockDoFicheiro(lockPath) {
  const prazoMs = duracaoDeAmbiente("CURATION_QUEUE_LOCK_PRAZO_MS", PRAZO_PADRAO_MS);
  const obsoletoMs = duracaoDeAmbiente("CURATION_QUEUE_LOCK_OBSOLETO_MS", OBSOLETO_PADRAO_MS);
  const inicio = Date.now();
  let espera = ESPERA_MIN_MS;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  for (;;) {
    const titular = await tentarCriar(lockPath);
    if (titular) return titular;
    if (await libertarSeObsoleto(lockPath, obsoletoMs)) continue;
    if (Date.now() - inicio >= prazoMs) {
      throw new CurationQueueLockError(`fila de curadoria ocupada: o lock ${lockPath} não foi libertado em ${prazoMs} ms`);
    }
    await dormir(espera);
    espera = Math.min(espera * 2, ESPERA_MAX_MS);
  }
}

/**
 * Liberta o lock tomado por adquirirLockDoFicheiro. Para a renovação e espera pela que estiver a
 * correr, para que não recrie o ficheiro depois de removido. Não lança: uma falha ao libertar não
 * deve trocar o resultado da operação. Sem renovação, o lock fica obsoleto ao fim de 10 min.
 * @param {{ lockPath: string, token: string, timer: any, renovando: Promise<void> | null }} titular
 */
export async function libertarLockDoFicheiro(titular) {
  clearInterval(titular.timer);
  if (titular.renovando) await titular.renovando;
  try {
    const atual = await lerLock(titular.lockPath);
    if (atual?.token !== titular.token) return;
    await fs.unlink(titular.lockPath).catch((err) => {
      if (err?.code !== "ENOENT") throw err;
    });
  } catch (err) {
    console.error(`[curationQueue] não foi possível libertar o lock ${titular.lockPath}: ${err?.message || err}`);
  }
}
