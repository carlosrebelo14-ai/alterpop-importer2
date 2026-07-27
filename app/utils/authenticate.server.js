import { authenticate, sessionStorage } from "../shopify.server";

/**
 * Autenticação Admin com reparação de sessão offline corrompida/expirada.
 * Se o refresh OAuth falhar (500), apaga a sessão para o próximo pedido forçar token exchange.
 *
 * @param {Request} request
 */
export async function authenticateAdmin(request) {
  try {
    return await authenticate.admin(request);
  } catch (error) {
    // Só limpar sessão em 401/403 — apagar em 500 genérico causava loop de login
    if (error instanceof Response && (error.status === 401 || error.status === 403)) {
      const shop = new URL(request.url).searchParams.get("shop");
      if (shop) {
        const sessionId = `offline_${shop}`;
        try {
          await sessionStorage.deleteSession(sessionId);
          console.warn(
            `[auth] Sessão offline removida (${sessionId}, HTTP ${error.status}). Reabre a app no Admin.`
          );
        } catch {
          /* ignorar */
        }
      }
    }
    throw error;
  }
}
