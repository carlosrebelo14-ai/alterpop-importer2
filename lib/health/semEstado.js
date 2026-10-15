/**
 * Ciclos sem estado no portão de saúde (DBG-06, relatório de 14/10/2026).
 *
 * Um ciclo que nunca correu (V13 live-drift, V14 coleções, V15 novidades, V17 ciclo de
 * vida) não tem ficheiro de estado. Antes isso passava como `info` e o portão ficava verde
 * sem nenhum ciclo ter corrido. Agora: sem estado é aviso; sem estado há 24 h é vermelho.
 *
 * "Há 24 h" conta desde a primeira corrida do portão que viu a ausência, gravada em
 * `semEstadoDesde` no health-gate-state.json. Não há carimbo de deploy para usar.
 *
 * Puro: sem fs, sem Prisma. A persistência fica em gateState.server.js.
 */

/** Horas sem estado de ciclo até o portão passar de aviso a vermelho. */
export const SEM_ESTADO_FAIL_HORAS = 24;

function isoValido(valor) {
  return typeof valor === "string" && !Number.isNaN(Date.parse(valor));
}

/**
 * Devolve o mapa `{ id: ISO }` depois de uma leitura do ciclo `id`.
 * Com estado, tira o id do mapa (o ciclo voltou a correr). Sem estado, mantém o instante
 * da primeira ausência, ou regista `agoraIso` se ainda não havia nenhum ou se o valor
 * guardado não é uma data.
 * @param {Record<string, string>} mapaAtual
 * @param {string} id
 * @param {boolean} temEstado
 * @param {string} agoraIso
 * @returns {Record<string, string>} mapa novo (nunca muta o recebido)
 */
export function registarSemEstado(mapaAtual, id, temEstado, agoraIso) {
  const novo = { ...(mapaAtual || {}) };
  if (temEstado) {
    delete novo[id];
    return novo;
  }
  novo[id] = isoValido(mapaAtual?.[id]) ? mapaAtual[id] : agoraIso;
  return novo;
}

/**
 * @param {string} desdeIso instante da primeira ausência
 * @param {number} agoraMs
 * @param {number} [limiteHoras]
 * @returns {{ vermelho: boolean, horas: number }}
 */
export function avaliarSemEstado(desdeIso, agoraMs, limiteHoras = SEM_ESTADO_FAIL_HORAS) {
  const horas = (agoraMs - Date.parse(desdeIso)) / 36e5;
  return { vermelho: horas >= limiteHoras, horas };
}
