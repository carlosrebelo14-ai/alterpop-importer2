/**
 * DBG-04, Decisão 2, lado do painel: alerta "Publicado na Shopify" de uma linha. O alerta existe quando o
 * produto foi criado na Shopify e chegou uma decisão humana durante a corrida, por isso o item não ficou
 * PUBLISHED. Módulo puro: o painel usa esta função, e o teste também.
 */

/**
 * @param {{ publicadoNaShopifyAlerta?: { em?: string, shopifyProductId?: string } | null } | null | undefined} item
 *   Linha do painel, com o alerta que vem da fila (metadata.alertaPublicadoNaShopify).
 * @returns {boolean} true se a linha deve mostrar o alerta
 */
export function mostrarAlertaPublicado(item) {
  return Boolean(item?.publicadoNaShopifyAlerta);
}
