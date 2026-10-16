/**
 * Reserva de publicação em memória (DBG-105). Uma publicação de cada vez, por processo.
 *
 * Pressupostos:
 *  - os chamadores de runApprovedShopifySync correm no processo principal da app: a publicação manual em
 *    api.shopify-sync.jsx (background em setImmediate) e o ciclo agendado em api.trigger-sync.jsx (dentro do IIFE).
 *    O worker de indexação (lib/workers/catalog-index-worker.mjs) não os chama;
 *  - o SQLite está num volume da Fly que só monta numa máquina. Por isso uma reserva em memória chega a todas as
 *    publicações. Confirmar o número de máquinas depois do deploy;
 *  - os scripts de linha de comando (scripts/catalog/run-approved-sync.js, scripts/sync/verify-post-ai-removal.js)
 *    correm noutro processo e não veem esta reserva. A proteção é num só sentido: um script recusa-se no arranque se a
 *    app já publica (recusarSeAtividadeApp), mas a app não lê o marcador de ficheiro do script. Risco registado como
 *    DBG-142, por decisão do arquiteto.
 *
 * A reserva é tomada de forma síncrona, sem await. Entre a verificação e a tomada não há ponto de suspensão, por isso
 * duas corridas no mesmo processo não passam ambas.
 */

let reservada = null;

/**
 * @returns {{ libertar: () => void } | null} reserva, ou null se já há uma publicação em curso
 */
export function tentarReservarPublicacao() {
  if (reservada !== null) return null;
  const dona = {};
  reservada = dona;
  return {
    libertar() {
      if (reservada === dona) reservada = null;
    },
  };
}
