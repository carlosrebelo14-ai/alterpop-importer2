/* eslint-env node */
/**
 * Pedido de scopes sem ecrã em branco dentro do Admin.
 *
 * `scopes.request()` (shopify-app-react-router) não devolve uma página: lança uma resposta
 * 401 SEM corpo, só com o header X-Shopify-API-Request-Failure-Reauthorize-Url. Esse header
 * só é seguido pelo App Bridge quando o pedido é um `fetch` com session token. Num pedido de
 * documento (iframe do Admin) o corpo vazio é um ecrã em branco e o URL de instalação nunca
 * abre. O `redirect` do `authenticate.admin` conhece os dois casos: com session token
 * devolve o header, num documento embebido devolve a página do App Bridge com
 * `window.open(url, "_top")`, que sai do iframe.
 *
 * @param {object} opts
 * @param {{ request: (scopes: string[]) => Promise<void> }} opts.scopes
 * @param {(url: string, init?: { target?: string }) => Response} opts.redirect
 *   o `redirect` devolvido por authenticate.admin
 * @param {string[]} opts.requested
 * @param {string} [opts.backTo] destino quando os scopes já estão concedidos
 */
export const REAUTH_URL_HEADER = "X-Shopify-API-Request-Failure-Reauthorize-Url";

export async function requestScopesOutOfFrame({ scopes, redirect, requested, backTo = "/app" }) {
  try {
    await scopes.request(requested);
  } catch (thrown) {
    const url = thrown instanceof Response ? thrown.headers.get(REAUTH_URL_HEADER) : null;
    if (!url) throw thrown;
    // `redirect` lança: App Bridge (documento embebido) ou header (fetch). Nunca um 401 vazio.
    return redirect(url, { target: "_top" });
  }
  // Já concedido. O `redirect` do authenticate.admin mantém shop/host/embedded/id_token; um
  // `redirect("/app")` simples do react-router perde-os e o iframe volta sem sessão.
  return redirect(backTo);
}
