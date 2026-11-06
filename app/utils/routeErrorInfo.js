/**
 * Descrição de um erro de rota para o ErrorBoundary (D1, briefing 06/11/2026). Nunca só o número de
 * estado: mostra a rota, o estado, o texto e o `data` da resposta. Um estado 2xx lançado como erro é o
 * "bounce" de autenticação do Shopify (pedido de dados sem session token), e diz-se isso.
 * @param {unknown} error
 * @param {string} pathname
 * @returns {{ route: string, status: number | null, title: string, detail: string, authBounce: boolean }}
 */
export function describeRouteError(error, pathname) {
  const route = pathname || "(rota desconhecida)";
  const e = /** @type {any} */ (error);
  const isResponse = e && typeof e === "object" && typeof e.status === "number" && ("statusText" in e || "data" in e);
  if (isResponse) {
    const status = e.status;
    const authBounce = status >= 200 && status < 300;
    let data = "";
    if (e.data !== undefined && e.data !== null && e.data !== "") {
      data = typeof e.data === "string" ? e.data : safeJson(e.data);
    }
    const statusText = e.statusText ? ` ${e.statusText}` : "";
    const title = authBounce
      ? `Pedido de dados recusado sem sessão (HTTP ${status})`
      : `Erro HTTP ${status}${statusText}`;
    const detail = authBounce
      ? `A resposta de reautenticação foi tratada como erro em ${route}. ${data}`.trim()
      : data || "Sem detalhe na resposta.";
    return { route, status, title, detail, authBounce };
  }
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : safeJson(e);
  return { route, status: null, title: "Erro de renderização", detail: message || "Sem detalhe do erro.", authBounce: false };
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
