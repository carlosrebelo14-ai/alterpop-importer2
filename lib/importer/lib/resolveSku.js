const PRODUCT_BY_SKU = `
  query ProductBySku($query: String!) {
    products(first: 1, query: $query) {
      nodes {
        id
        title
        syncLockedMetafield: metafield(namespace: "ociostock", key: "sync_locked") {
          value
        }
        variants(first: 20) {
          nodes {
            id
            sku
            price
            inventoryItem {
              id
            }
          }
        }
      }
    }
  }
`;

/** Causas de erro de API que o resumo do ciclo distingue (C8). */
export const LOOKUP_ERROR_CAUSES = Object.freeze({
  RETRY_EXHAUSTED: "retry_esgotado",
  TIMEOUT: "timeout",
  HTTP_AUTH: "http_401_403",
  HTTP_4XX: "http_4xx",
  HTTP_5XX: "http_5xx",
  NETWORK: "rede",
  GRAPHQL: "graphql",
  BAD_RESPONSE: "resposta_invalida",
  OTHER: "outra",
});

/**
 * Causa de um erro de API, sem SKUs nem texto livre (o repo é público e o resumo vai para o log).
 * @param {unknown} err
 * @returns {string} um valor de LOOKUP_ERROR_CAUSES
 */
export function classifyLookupError(err) {
  const e = /** @type {any} */ (err);
  const msg = String(e?.message || err || "");
  if (e?.code === "SHOPIFY_TIMEOUT" || e?.name === "ShopifyTimeoutError") return LOOKUP_ERROR_CAUSES.TIMEOUT;
  if (msg.includes("failed after retries")) return LOOKUP_ERROR_CAUSES.RETRY_EXHAUSTED;
  const http = msg.match(/Shopify HTTP (\d{3})/);
  if (http) {
    const code = Number(http[1]);
    if (code === 401 || code === 403) return LOOKUP_ERROR_CAUSES.HTTP_AUTH;
    if (code >= 500) return LOOKUP_ERROR_CAUSES.HTTP_5XX;
    return LOOKUP_ERROR_CAUSES.HTTP_4XX;
  }
  if (msg.includes("resposta inválida")) return LOOKUP_ERROR_CAUSES.BAD_RESPONSE;
  if (e?.name === "TypeError" || /fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|socket|network/i.test(msg)) return LOOKUP_ERROR_CAUSES.NETWORK;
  if (e instanceof Error && !(e?.name === "TypeError")) return LOOKUP_ERROR_CAUSES.GRAPHQL;
  return LOOKUP_ERROR_CAUSES.OTHER;
}

/**
 * Resolve um SKU com três resultados distintos (C1, C2, C7).
 *  - `found`      variante encontrada.
 *  - `not_found`  resposta válida com `products.nodes` vazio. É a única prova de ausência.
 *  - `error`      qualquer outra coisa (throttle esgotado, 4xx, 5xx, rede, resposta inesperada).
 * Só `found` e `not_found` entram na cache. Um `error` nunca é guardado, para o SKU ser tentado outra vez.
 *
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} sku
 * @param {Map<string, object|null>} cache
 * @returns {Promise<{ status: 'found', variant: any } | { status: 'not_found' } | { status: 'error', cause: string, message: string }>}
 */
export async function lookupVariantBySku(client, sku, cache) {
  if (cache.has(sku)) {
    const cached = cache.get(sku);
    return cached ? { status: "found", variant: cached } : { status: "not_found" };
  }

  const cleanSku = String(sku || "").trim();
  if (!cleanSku) return { status: "error", cause: LOOKUP_ERROR_CAUSES.BAD_RESPONSE, message: "SKU vazio" };

  const safeSku = cleanSku.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  let data;
  try {
    data = await client.graphql(PRODUCT_BY_SKU, { query: `sku:"${safeSku}"` });
  } catch (err) {
    return { status: "error", cause: classifyLookupError(err), message: err?.message || String(err) };
  }

  const nodes = data?.products?.nodes;
  if (!Array.isArray(nodes)) {
    return { status: "error", cause: LOOKUP_ERROR_CAUSES.BAD_RESPONSE, message: "resposta inválida da Shopify (sem products.nodes)" };
  }
  if (nodes.length === 0) {
    cache.set(sku, null);
    return { status: "not_found" };
  }

  const productNode = nodes[0];
  const matchedVariant =
    productNode.variants?.nodes?.find((v) => (v.sku || "").trim().toLowerCase() === cleanSku.toLowerCase()) ||
    productNode.variants?.nodes?.[0] ||
    null;
  if (!matchedVariant) {
    // Há produto mas nenhuma variante legível: não é prova de ausência.
    return { status: "error", cause: LOOKUP_ERROR_CAUSES.BAD_RESPONSE, message: "resposta inválida da Shopify (produto sem variantes)" };
  }

  const variant = {
    id: matchedVariant.id,
    sku: matchedVariant.sku,
    // syncLocked vem já nesta mesma query (metafield ociostock.sync_locked) em vez de precisar de uma
    // chamada GraphQL extra por produto (achado de eficiência no code review, 2026-08-12).
    product: {
      id: productNode.id,
      title: productNode.title,
      syncLocked: productNode.syncLockedMetafield?.value === "true",
    },
    inventoryItem: matchedVariant.inventoryItem || null,
    // Preço live — o publisher só escreve preço num produto existente quando está a 0 (nunca foi preço
    // escolhido por ninguém); ver existingPriceNeedsWrite.
    price: matchedVariant.price ?? null,
  };
  cache.set(sku, variant);
  return { status: "found", variant };
}

/**
 * Compatível com os chamadores que só querem a variante. `null` só quando o SKU não existe (`not_found`).
 * Um erro de API LANÇA em vez de virar `null`: antes, um 401 ou um throttle esgotado devolvia `null` e o
 * publisher criava um segundo produto para um SKU que já existia.
 *
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} sku
 * @param {Map<string, object|null>} cache
 */
export async function resolveVariantBySku(client, sku, cache) {
  const r = await lookupVariantBySku(client, sku, cache);
  if (r.status === "found") return r.variant;
  if (r.status === "not_found") return null;
  const err = new Error(`Falha de API ao resolver o SKU (${r.cause}): ${r.message}`);
  /** @type {any} */ (err).code = "SKU_LOOKUP_FAILED";
  /** @type {any} */ (err).cause = r.cause;
  throw err;
}
