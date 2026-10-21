/**
 * DBG-123. Motivo de uma linha recusada no import de edições. Com o override já gravado, a linha diz que a aprovação ou
 * a rejeição não ficou feita, qualquer que seja a causa. O DBG-110 cobria só o timeout da fila.
 * @param {{ err: unknown, gravou: boolean }} params
 * @returns {string}
 */
export function motivoDaLinhaRecusada({ err, gravou }) {
  const mensagem = err?.message || "Erro desconhecido ao aplicar";
  if (!gravou) return mensagem;
  if (err?.code === "CURATION_QUEUE_LOCK_TIMEOUT") {
    return "fila ocupada: o override foi gravado, a aprovação ou a rejeição não. Repetir esta linha.";
  }
  return `o override foi gravado, a aprovação ou a rejeição não (${mensagem}).`;
}
