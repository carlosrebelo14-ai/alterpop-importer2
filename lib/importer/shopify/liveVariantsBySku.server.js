/**
 * Leitura de variantes live por SKU — partilhada pelo ciclo de erosão de margem
 * (marginErosion.server.js) e pela reconciliação de preços
 * (scripts/catalog/price-reconcile-{dry-run,apply}.js). Só leitura.
 *
 * Também diagnostica os PUBLISHED da fila sem variante live: fila e loja discordam, e
 * isso tem de aparecer com a causa, nunca em silêncio (revisão do dry-run, 07/10/2026).
 */

const CHUNK = 40; // SKUs por query — mantém a string de busca dentro de limites seguros
const DESTROY_EVENTS_PAGE = 250;

const VARIANTS_BY_SKU_QUERY = `
  query LiveVariantsBySku($query: String!) {
    productVariants(first: 250, query: $query) {
      nodes {
        id
        sku
        price
        product {
          id
          title
          status
          syncLocked: metafield(namespace: "ociostock", key: "sync_locked") { value }
        }
      }
    }
  }
`;

const PRODUCT_BY_ID_QUERY = `
  query OrphanProduct($id: ID!) {
    product(id: $id) {
      id
      title
      status
      variants(first: 5) { nodes { sku } }
    }
  }
`;

const DESTROY_EVENTS_QUERY = `
  query ProductDestroyEvents($first: Int!) {
    events(first: $first, sortKey: CREATED_AT, reverse: true, query: "subject_type:PRODUCT AND action:destroy") {
      nodes {
        createdAt
        ... on BasicEvent { subjectId }
      }
    }
  }
`;

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * @typedef {{ variantId: string, productId: string, price: number, title: string|null,
 *   status: string|null, syncLocked: boolean, duplicate?: boolean }} LiveVariant
 */

/**
 * Lê as variantes live dos SKUs pedidos. Um chunk que falhe lança — uma lista
 * incompleta faria SKUs existentes parecerem órfãos.
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string[]} skus
 * @returns {Promise<Map<string, LiveVariant>>}
 */
export async function fetchLiveVariantsBySku(client, skus) {
  const wanted = new Set(skus);
  /** @type {Map<string, LiveVariant>} */
  const bySku = new Map();
  for (const chunk of chunkArray(skus, CHUNK)) {
    const query = chunk.map((s) => `sku:"${String(s).replace(/"/g, '\\"')}"`).join(" OR ");
    const data = await client.graphql(VARIANTS_BY_SKU_QUERY, { query });
    for (const v of data.productVariants?.nodes || []) {
      // A busca `sku:` da Shopify não é igualdade estrita — só conta o SKU exato.
      if (!wanted.has(v.sku)) continue;
      if (bySku.has(v.sku)) {
        bySku.set(v.sku, { ...bySku.get(v.sku), duplicate: true });
        continue;
      }
      bySku.set(v.sku, {
        variantId: v.id,
        productId: v.product?.id || null,
        price: Number(v.price),
        title: v.product?.title || null,
        status: v.product?.status || null,
        syncLocked: v.product?.syncLocked?.value === "true",
      });
    }
  }
  return bySku;
}

/**
 * Causa de cada PUBLISHED sem variante live, a partir do shopifyProductId guardado na
 * fila (markQueueItemPublished). Erros de leitura viram causa explícita, nunca omissão.
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {{ sku: string, metadata?: { shopifyProductId?: string|null } }[]} items
 * @returns {Promise<Map<string, string>>} sku → causa
 */
export async function diagnoseMissingLive(client, items) {
  /** @type {Map<string, string>} */
  const reasons = new Map();
  if (!items.length) return reasons;

  /** @type {Map<string, string>|null} subjectId → createdAt; null = leitura falhou */
  let destroyedAt = null;
  const loadDestroyEvents = async () => {
    if (destroyedAt) return destroyedAt;
    const data = await client.graphql(DESTROY_EVENTS_QUERY, { first: DESTROY_EVENTS_PAGE });
    destroyedAt = new Map((data.events?.nodes || []).filter((e) => e.subjectId).map((e) => [e.subjectId, e.createdAt]));
    return destroyedAt;
  };

  for (const item of items) {
    const productId = item.metadata?.shopifyProductId || null;
    if (!productId) {
      reasons.set(item.sku, "PUBLISHED na fila sem shopifyProductId guardado — sem variante live com este SKU");
      continue;
    }
    try {
      const data = await client.graphql(PRODUCT_BY_ID_QUERY, { id: productId });
      const product = data.product;
      if (!product) {
        let when = null;
        try {
          when = (await loadDestroyEvents()).get(productId) || null;
        } catch (err) {
          when = `data não lida (${err?.message || err})`;
        }
        reasons.set(
          item.sku,
          when
            ? `produto ${productId} apagado na Shopify em ${when}; a fila continua PUBLISHED`
            : `produto ${productId} já não existe na Shopify (apagado há mais de ${DESTROY_EVENTS_PAGE} eventos); a fila continua PUBLISHED`
        );
        continue;
      }
      const liveSkus = (product.variants?.nodes || []).map((v) => v.sku || "(vazio)").join(", ");
      reasons.set(
        item.sku,
        `produto ${productId} existe (${product.status}) mas com SKU ${liveSkus} — SKU mudado fora da app`
      );
    } catch (err) {
      reasons.set(item.sku, `diagnóstico falhou para ${productId}: ${err?.message || err}`);
    }
  }
  return reasons;
}
