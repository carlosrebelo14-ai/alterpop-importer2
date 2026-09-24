/**
 * Verificação de access scopes concedidos — B14 (briefing backend, 24/09/2026), secção 4.
 * Módulo puro, sem I/O: quem chama traz a lista de handles concedidos (de
 * currentAppInstallation.accessScopes) e a lista de handles exigidos.
 *
 * Existir declarado em shopify.app.toml prova o PEDIDO, não a CONCESSÃO — só
 * currentAppInstallation.accessScopes (consultado com a sessão OAuth ativa) diz o que a
 * loja concedeu de facto.
 *
 * Dois consumidores:
 * - scripts/maintenance/print-access-scopes.js — script de leitura, exige os dois scopes
 *   de publicação e sai com código de erro se faltar algum.
 * - collectionPublication.server.js (secção 6, por escrever) — chama isto no início de
 *   cada ciclo com REQUIRED_PUBLISH_SCOPES; se write_publications faltar, deixa o V14
 *   vermelho e salta só a publicação, sem abortar o resto do ciclo (mesma regra do
 *   publicationId inválido).
 */

export const REQUIRED_PUBLISH_SCOPES = ["read_publications", "write_publications"];

/**
 * @param {string[]} grantedHandles handles de currentAppInstallation.accessScopes[].handle
 * @param {string[]} requiredHandles
 * @returns {{ granted: string[], required: string[], missing: string[], ok: boolean }}
 */
export function checkAccessScopes(grantedHandles, requiredHandles) {
  const granted = Array.isArray(grantedHandles) ? grantedHandles : [];
  const required = Array.isArray(requiredHandles) ? requiredHandles : [];
  const grantedSet = new Set(granted);
  const missing = required.filter((h) => !grantedSet.has(h));
  return { granted, required, missing, ok: missing.length === 0 };
}
