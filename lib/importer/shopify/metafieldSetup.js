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
  query ProductMetafieldDefinition($namespace: String!, $key: String!) {
    metafieldDefinitions(
      first: 1
      ownerType: PRODUCT
      namespace: $namespace
      key: $key
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
export const OCIOSTOCK_DIMENSIONS_DEFINITION = {
  namespace: "ociostock",
  key: "dimensions",
  name: "Package dimensions",
  description: "Package dimensions (W × H × D) in cm, from OcioStock xml_info_dimensiones",
  ownerType: "PRODUCT",
  type: "single_line_text_field",
};

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
export async function ensureMetafieldDefinition(client, def) {
  const existing = await client.graphql(METAFIELD_QUERY, {
    namespace: def.namespace,
    key: def.key,
  });
  const found = existing.metafieldDefinitions?.nodes?.[0];
  if (found?.id) {
    return { created: false, definition: found };
  }

  const data = await client.graphql(METAFIELD_CREATE, {
    definition: {
      namespace: def.namespace,
      key: def.key,
      name: def.name,
      description: def.description,
      ownerType: def.ownerType,
      type: def.type,
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
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @deprecated usa ensureMetafieldDefinition(client, OCIOSTOCK_NET_PRICE_DEFINITION)
 */
export async function createOciostockNetPriceMetafield(client) {
  return ensureMetafieldDefinition(client, OCIOSTOCK_NET_PRICE_DEFINITION);
}

/**
 * Garante definição ociostock.net_price (cria via API se ausente).
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {import('../jobs/ImportJob.js').ImportJob} [job]
 */
export async function ensureOciostockMetafieldDefinitions(client, job) {
  try {
    const defs = [OCIOSTOCK_NET_PRICE_DEFINITION, OCIOSTOCK_DIMENSIONS_DEFINITION];
    const results = [];
    for (const def of defs) {
      const r = await ensureMetafieldDefinition(client, def);
      results.push({ ...r, def });
    }
    const payload = {
      ok: true,
      message: results
        .map((r) => `${r.def.namespace}.${r.def.key} ${r.created ? "created via API" : "already exists"}`)
        .join("; "),
      definition: {
        id: results[0].definition.id,
        type: results[0].definition.type?.name,
      },
      definitions: results.map((r) => ({
        namespace: r.def.namespace,
        key: r.def.key,
        id: r.definition.id,
        created: r.created,
      })),
      created: results.some((r) => r.created),
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
