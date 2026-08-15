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
  query OciostockMetafieldDefinition($namespace: String!, $key: String!, $ownerType: MetafieldOwnerType!) {
    metafieldDefinitions(
      first: 1
      ownerType: $ownerType
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

export const OCIOSTOCK_BRAND_DEFINITION = {
  namespace: "ociostock",
  key: "brand",
  name: "Brand",
  description: "Marca do fornecedor (vendor), como metafield estruturado para filtros da loja",
  ownerType: "PRODUCT",
  type: "single_line_text_field",
};

/** Item 5 do pacote de melhorias criativas de 2026-08-12 — licença primária do produto
 * (1.ª franchise), usada como condição de regra nas smart collections automáticas por
 * licença (ver autoCollections.server.js). */
export const OCIOSTOCK_LICENCE_DEFINITION = {
  namespace: "ociostock",
  key: "licence",
  name: "Licença / franchise",
  description: "Licença primária do produto (ex.: Star Wars, Marvel) — usada para agrupar em coleções automáticas",
  ownerType: "PRODUCT",
  type: "single_line_text_field",
};

/** Catálogo completo de licenças/franquias conhecidas e se têm stock publicado, para a
 * grelha de franquias do tema (ver franchiseCatalogSync.server.js). Metafield de LOJA,
 * não de produto — um único valor recalculado a cada sync completo. */
export const OCIOSTOCK_FRANCHISE_CATALOG_DEFINITION = {
  namespace: "ociostock",
  key: "franchise_catalog",
  name: "Catálogo de franquias com stock",
  description: "JSON [{ label, hasStock }] — todas as licenças conhecidas e se têm ≥1 produto publicado com stock. Recalculado a cada sync.",
  ownerType: "SHOP",
  type: "json",
};

export const OCIOSTOCK_SYNC_LOCKED_DEFINITION = {
  namespace: "ociostock",
  key: "sync_locked",
  name: "Sync bloqueado",
  description: "Se true, o próximo ciclo de sync não sobrescreve título/preço/categoria/descrição deste produto (stock continua a actualizar). Editar manualmente aqui no Admin.",
  ownerType: "PRODUCT",
  type: "boolean",
};

/**
 * Cria a definição ociostock.net_price se ainda não existir.
 * @param {import('../shopifyClient.js').ShopifyClient} client
 */
export async function ensureMetafieldDefinition(client, def) {
  const existing = await client.graphql(METAFIELD_QUERY, {
    namespace: def.namespace,
    key: def.key,
    ownerType: def.ownerType,
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
    const defs = [
      OCIOSTOCK_NET_PRICE_DEFINITION,
      OCIOSTOCK_DIMENSIONS_DEFINITION,
      OCIOSTOCK_BRAND_DEFINITION,
      OCIOSTOCK_SYNC_LOCKED_DEFINITION,
      OCIOSTOCK_LICENCE_DEFINITION,
    ];
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
