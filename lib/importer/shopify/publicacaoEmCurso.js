import path from "node:path";
import { resolveCurationDataDir } from "../../curation/dataDir.js";
import {
  CurationQueueLockError,
  adquirirLockDoFicheiro,
  libertarLockDoFicheiro,
} from "../../curation/curationQueueFileLock.server.js";

/**
 * Reserva de publicação (DBG-105, DBG-142). Uma publicação de cada vez, entre processos.
 *
 * Duas camadas:
 *  - em memória, síncrona (tentarReservarPublicacao): protege o processo da app sem nenhum ponto de suspensão entre a
 *    verificação e a tomada;
 *  - trinco de ficheiro (DBG-142, decisão do arquiteto, 21/10): reservarPublicacaoEntreProcessos toma-o depois da
 *    reserva em memória. A publicação manual, o ciclo, o reset e o run-approved-sync tomam o mesmo trinco. Quem o
 *    encontra ocupado recusa, sem esperar. O trinco tem batimento: o módulo de trinco renova-o enquanto o processo vive,
 *    e um processo morto deixa-o expirar.
 *
 * O SQLite está num volume da Fly que só monta numa máquina. O trinco de ficheiro protege os processos dessa máquina.
 *
 * Publicação presa (DBG-149, decisão do arquiteto): a reserva sai só no finally do motor e não tem prazo de
 * inatividade. O clearLock da UI não a liberta. A recuperação de uma publicação presa é reiniciar a máquina.
 */

let reservada = null;

/** DBG-142: trinco de ficheiro da publicação entre processos. Fica no diretório de estado da fila, como os marcadores. */
export function caminhoDoTrincoDePublicacao() {
  return path.join(resolveCurationDataDir(), "shopify-publish.lock");
}

/**
 * PR 5 (revisão): a marca da app nasce no mesmo passo síncrono da reserva. Um script que arranque depois já a vê, sem
 * a janela entre a reserva e a marca do motor. Se a marca falhar, a reserva sai e o erro sobe (fail closed).
 * @param {{ marcar?: () => () => void }} [opcoes]
 * @returns {{ libertar: () => void } | null} reserva, ou null se já há uma publicação em curso
 */
export function tentarReservarPublicacao({ marcar } = {}) {
  if (reservada !== null) return null;
  const dona = {};
  reservada = dona;
  let retirarMarca = () => {};
  if (typeof marcar === "function") {
    try {
      retirarMarca = marcar();
    } catch (err) {
      if (reservada === dona) reservada = null;
      throw err;
    }
  }
  return {
    libertar() {
      if (reservada === dona) reservada = null;
      retirarMarca();
    },
  };
}

/**
 * DBG-142: reserva entre processos. Toma primeiro a reserva em memória (síncrona), e depois o trinco de ficheiro, sem
 * esperar. Se outro processo publica ou faz um reset, devolve null e a reserva em memória sai. O `libertar` devolvido
 * sai das duas camadas, pela mesma ordem de sempre.
 * @param {{ marcar?: () => () => void }} [opcoes]
 * @returns {Promise<{ libertar: () => Promise<void> } | null>}
 */
export async function reservarPublicacaoEntreProcessos({ marcar } = {}) {
  const interna = tentarReservarPublicacao({ marcar });
  if (!interna) return null;
  let trinco;
  try {
    trinco = await adquirirLockDoFicheiro(caminhoDoTrincoDePublicacao(), {
      prazoMs: 0,
      rotulo: "[publicacao] outra publicação ou reset Shopify em curso noutro processo",
    });
  } catch (err) {
    interna.libertar();
    if (err instanceof CurationQueueLockError) return null;
    throw err;
  }
  return {
    async libertar() {
      interna.libertar();
      await libertarLockDoFicheiro(trinco);
    },
  };
}

/**
 * Há uma publicação ou um reset Shopify com a reserva tomada agora (PR 5). Só leitura. A indexação usa-a para não
 * arrancar por cima de uma publicação, e a publicação manual confirma-a depois de tomar a reserva.
 * @returns {boolean}
 */
export function publicacaoOuResetEmCurso() {
  return reservada !== null;
}
