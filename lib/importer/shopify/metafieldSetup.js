const METAFIELD_CREATE = `
  mutation OciostockNetPriceDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id
        name
        namespace
        key
        type { name }
      }
      userErrors { field message }
    }
  }
`;

const METAFIELD_QUERY = `
  query OciostockNetPriceDefinition {
    metafieldDefinitions(
      first: 1
      ownerType: PRODUCT
      namespace: "ociostock"
      key: "net_price"
    ) {
      nodes {
        id
        name
        namespace
        key
        type { name }
      }
    }
  }
`;

/**
 * Verify product metafield definition ociostock.net_price exists before live import.
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {import('../jobs/ImportJob.js').ImportJob} job
 * @returns {Promise<boolean>}
 */
export const OCIOSTOCK_NET_PRICE_DEFINITION = {
  namespace: "ociostock",
  key: "net_price",
  name: "OcioStock net price",
  description: "Supplier net price from OcioStock (precio_neto)",
  ownerType: "PRODUCT",
  type: "number_decimal",
};

/**
 * Cria a definição ociostock.net_price se ainda não existir.
 * @param {import('../shopifyClient.js').ShopifyClient} client
 */
export async function createOciostockNetPriceMetafield(client) {
  const existing = await client.graphql(METAFIELD_QUERY);
  const def = existing.metafieldDefinitions?.nodes?.[0];
  if (def?.id) {
    return { created: false, definition: def };
  }

  const data = await client.graphql(METAFIELD_CREATE, {
    definition: {
      namespace: OCIOSTOCK_NET_PRICE_DEFINITION.namespace,
      key: OCIOSTOCK_NET_PRICE_DEFINITION.key,
      name: OCIOSTOCK_NET_PRICE_DEFINITION.name,
      description: OCIOSTOCK_NET_PRICE_DEFINITION.description,
      ownerType: OCIOSTOCK_NET_PRICE_DEFINITION.ownerType,
      type: OCIOSTOCK_NET_PRICE_DEFINITION.type,
    },
  });

  const errors = data.metafieldDefinitionCreate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => e.message).join("; "));
  }

  const created = data.metafieldDefinitionCreate?.createdDefinition;
  if (!created?.id) {
    throw new Error("metafieldDefinitionCreate returned no definition");
  }

  return { created: true, definition: created };
}

/**
 * Garante definição ociostock.net_price (cria via API se ausente).
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {import('../jobs/ImportJob.js').ImportJob} [job]
 */
export async function ensureOciostockMetafieldDefinitions(client, job) {
  try {
    const result = await createOciostockNetPriceMetafield(client);
    const payload = {
      ok: true,
      message: result.created
        ? "Metafield definition ociostock.net_price created via API"
        : "Metafield definition ociostock.net_price already exists",
      definition: {
        id: result.definition.id,
        type: result.definition.type?.name,
      },
      created: result.created,
    };
    if (job) await job.logMetafieldCheck(payload);
    return true;
  } catch (err) {
    const message = err?.message || String(err);
    if (job) {
      await job.logMetafieldCheck({ ok: false, message });
      job.recordFailed({
        sku: "(setup)",
        type: "metafield_definition",
        reason: message,
      });
    }
    throw err;
  }
}

/** @deprecated use ensureOciostockMetafieldDefinitions */
export async function verifyOciostockNetPriceMetafield(client, job) {
  return ensureOciostockMetafieldDefinitions(client, job);
}
