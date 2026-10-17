/**
 * DBG-152. Última falha da indexação do catálogo, gravada no ficheiro de estado como `lastFailure {at, causa, error}`.
 *
 * O texto de `error` fica no ficheiro e nunca sai para logs, resumos nem V16 (decisão do arquiteto, 17/10). Quem
 * mostra a falha vê só a causa (lista fechada), a data e a classe do texto (lista fechada).
 *
 * Este módulo é puro: não importa nada. O indexing-status.mjs não o importa, porque corre na Fly sem deploy e tem
 * de ser autónomo. Tem cópias destas listas, e um teste pina que dão o mesmo resultado.
 */

/** Causas de falha de uma corrida. Lista fechada. Qualquer outra coisa grava-se como erro_worker. */
export const CAUSAS_FALHA = Object.freeze([
  "worker_saiu", // saída do worker com código, ou sem mensagem final (inclui saída antes do try e antes do done)
  "worker_morto", // saída do worker por sinal
  "erro_worker", // o worker mandou uma mensagem de erro
  "erro_pai", // o processo principal teve um erro ao lidar com o worker
  "marcador", // não foi possível marcar a atividade da app
  "estado_nao_gravado", // o estado não ficou no disco no arranque ou no fim
  "erro_script", // um script de reindexação (full-catalog-reindex) falhou fora do worker
]);

/** Classes do texto de erro. A ordem importa: a primeira que bater ganha. Tudo o que não bate é "outra". */
export const CLASSES_ERRO = Object.freeze([
  [/^\[fila\]|CURATION_QUEUE_LOCK/, "fila"],
  [/^worker process exited/, "worker_saiu"],
  [/^worker process killed/, "worker_morto"],
  [/^A indexação não arrancou/, "marcador"],
  [/estado de indexação ilegível/, "ilegivel"],
]);

/** @param {unknown} erro @returns {string} */
export function classeDoErro(erro) {
  if (erro === null || erro === undefined || erro === "") return "nenhum";
  const texto = String(erro);
  const encontrada = CLASSES_ERRO.find(([re]) => re.test(texto));
  return encontrada ? encontrada[1] : "outra";
}

/**
 * Registo da última falha, para gravar no ficheiro de estado. A causa é normalizada para a lista fechada.
 * @param {string} causa
 * @param {unknown} error
 * @param {string} [em]
 * @returns {{ at: string, causa: string, error: string }}
 */
export function registoDaFalha(causa, error, em = new Date().toISOString()) {
  return {
    at: em,
    causa: CAUSAS_FALHA.includes(causa) ? causa : "erro_worker",
    error: String(error ?? ""),
  };
}

/**
 * Descrição da última falha, para o V16. Diz a causa, a data e a classe. Nunca o texto de `error`.
 * Um estado sem `lastFailure` (gravado antes deste registo) diz só "erro desconhecido".
 * @param {{ lastFailure?: unknown } | null | undefined} estado
 * @returns {string}
 */
export function descreverUltimaFalha(estado) {
  const falha = estado?.lastFailure;
  if (!falha || typeof falha !== "object") return "erro desconhecido";
  const causa = CAUSAS_FALHA.includes(falha.causa) ? falha.causa : "?";
  const em = typeof falha.at === "string" && /^[0-9TZ:.+-]{1,40}$/.test(falha.at) ? falha.at : "?";
  return `causa ${causa}, em ${em}, classe ${classeDoErro(falha.error)}`;
}
