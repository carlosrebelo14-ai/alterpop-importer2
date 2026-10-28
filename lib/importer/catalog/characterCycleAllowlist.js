/**
 * characterCycleAllowlist — classes de ação autorizadas para o primeiro ciclo com a trava levantada
 * (decisão do arquiteto, 27/10/2026). Puro, sem I/O.
 *
 * Autorizadas:
 *  - reativar darth-vader, grogu e luke-skywalker;
 *  - criar ahsoka-tano e qualquer nome do vocabulário aprovado;
 *  - atualizar personagens existentes;
 *  - corrigir alterpop.character de produtos (product-update, 29/10/2026): só pede o que ProductCharacter diz;
 *  - pôr em DRAFT luffy, goku e vegeta.
 * Qualquer outra ação fica de fora e aborta o comando sem escrever.
 */
import { CHARACTER_VOCABULARY } from "./characterVocabulary.js";
import { handleCanonico } from "./characterResolver.server.js";

export const REATIVAR_AUTORIZADAS = new Set(["darth-vader", "grogu", "luke-skywalker"]);
export const DRAFT_AUTORIZADAS = new Set(["luffy", "goku", "vegeta"]);
// Creates: qualquer nome do vocabulário aprovado (ronda 1, 28/10/2026), mais ahsoka-tano.
export const CRIAR_AUTORIZADAS = new Set([
  "ahsoka-tano",
  ...CHARACTER_VOCABULARY.flatMap((e) => e.nomes.map(handleCanonico)),
]);

/**
 * @param {Array<{ handle: string, action: string }>} actions
 * @returns {{ permitidas: object[], fora: Array<{ handle: string, action: string, motivo: string }> }}
 */
export function classificarAcoesAutorizadas(actions) {
  const permitidas = [];
  const fora = [];
  for (const a of actions) {
    if (a.action === "skip" || a.action === "error" || a.action === "noop") continue;
    if (a.action === "update" || a.action === "product-update") {
      permitidas.push(a);
      continue;
    }
    if (a.action === "reactivate" && REATIVAR_AUTORIZADAS.has(a.handle)) {
      permitidas.push(a);
      continue;
    }
    if (a.action === "create" && CRIAR_AUTORIZADAS.has(a.handle)) {
      permitidas.push(a);
      continue;
    }
    if (a.action === "set-draft" && DRAFT_AUTORIZADAS.has(a.handle)) {
      permitidas.push(a);
      continue;
    }
    fora.push({ handle: a.handle, action: a.action, motivo: `${a.action} fora das classes autorizadas` });
  }
  return { permitidas, fora };
}
