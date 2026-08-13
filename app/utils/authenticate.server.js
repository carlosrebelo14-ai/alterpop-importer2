import { authenticate } from "../shopify.server";

/**
 * Autenticação Admin.
 *
 * ATENÇÃO (fix de segurança, code review 2026-08-13): esta função costumava apagar a
 * sessão offline da loja indicada em `?shop=` sempre que `authenticate.admin` falhava
 * com 401/403. Como esse parâmetro vem do URL do pedido e NÃO é verificado (o pedido
 * já falhou a autenticação nesse ponto), qualquer chamada não autenticada com
 * `?shop=<loja-alvo>` conseguia forçar essa loja a reautenticar — DoS de sessão sem
 * precisar de saber nada além do domínio da loja. Removido: só regista o erro, nunca
 * apaga sessão com base em dados não verificados. O próprio `authenticate.admin` já
 * trata o redirecionamento para reautenticação quando a sessão está mesmo inválida.
 *
 * @param {Request} request
 */
export async function authenticateAdmin(request) {
  try {
    return await authenticate.admin(request);
  } catch (error) {
    if (error instanceof Response && (error.status === 401 || error.status === 403)) {
      console.warn(`[auth] authenticate.admin falhou com HTTP ${error.status}.`);
    }
    throw error;
  }
}
