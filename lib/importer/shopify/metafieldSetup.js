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
      ...(def.validations ? { validations: def.validations } : {}),
      ...(def.access ? { access: def.access } : {}),
      ...(def.pin !== undefined ? { pin: def.pin } : {}),
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

const METAFIELD_SHAPE_READ = `
  query MetafieldDefinitionShapeRead($namespace: String!, $key: String!, $ownerType: MetafieldOwnerType!) {
    metafieldDefinitions(first: 1, ownerType: $ownerType, namespace: $namespace, key: $key) {
      nodes { id namespace key pinnedPosition type { name } access { admin storefront } capabilities { smartCollectionCondition { enabled } } }
    }
  }
`;

const METAFIELD_SHAPE_UPDATE = `
  mutation MetafieldDefinitionShapeUpdate($definition: MetafieldDefinitionUpdateInput!) {
    metafieldDefinitionUpdate(definition: $definition) {
      updatedDefinition { id namespace key type { name } access { admin storefront } capabilities { smartCollectionCondition { enabled } } }
      userErrors { field message code }
    }
  }
`;

const storefrontOf = (def) => def.access?.storefront ?? "NONE";
const sccOf = (def) => def.capabilities?.smartCollectionCondition?.enabled === true;

/**
 * Input de metafieldDefinitionUpdate que alinha a definição da loja com a forma
 * declarada (access.storefront + capabilities.smartCollectionCondition) — briefing 27/09.
 * Devolve null se a loja já bate com a forma (idempotência).
 *
 * Leva SEMPRE os dois campos, mesmo o que não muda: a 27/09 um update só com `access`
 * desligou em silêncio o smartCollectionCondition de alterpop.format (a Shopify repõe
 * capabilities omitidas). Mesma classe de defeito que o `pin` da ADENDA 2 (18/09).
 *
 * Nunca declara access.admin: o namespace `alterpop` é merchant-owned.
 * Testado em scripts/tests/metafield-definition-access.test.js.
 *
 * @param {{ namespace: string, key: string, ownerType: string, access?: { storefront?: string }, capabilities?: object }} def forma declarada
 * @param {{ access?: { storefront?: string }, capabilities?: object } | null} current definição lida da loja
 */
export function buildDefinitionShapeUpdateInput(def, current) {
  if (storefrontOf(current) === storefrontOf(def) && sccOf(current) === sccOf(def)) return null;
  return {
    namespace: def.namespace,
    key: def.key,
    ownerType: def.ownerType,
    access: { storefront: storefrontOf(def) },
    capabilities: { smartCollectionCondition: { enabled: sccOf(def) } },
  };
}

/** Lê a definição (id, tipo, pin, acesso, smartCollectionCondition) da loja. null se não existir. */
export async function readMetafieldDefinitionShape(client, def) {
  const data = await client.graphql(METAFIELD_SHAPE_READ, {
    namespace: def.namespace,
    key: def.key,
    ownerType: def.ownerType,
  });
  return data.metafieldDefinitions?.nodes?.[0] || null;
}

/**
 * Aplica o input de buildDefinitionShapeUpdateInput. Lança em userErrors ou se a
 * resposta não trouxer o acesso E a capability pedidos — nada falha em silêncio.
 */
export async function updateMetafieldDefinitionShape(client, input) {
  const data = await client.graphql(METAFIELD_SHAPE_UPDATE, { definition: input });
  const errors = data.metafieldDefinitionUpdate?.userErrors || [];
  const label = `${input.namespace}.${input.key}`;
  if (errors.length) {
    throw new Error(`${label}: ${errors.map((e) => e.message).join("; ")}`);
  }
  const updated = data.metafieldDefinitionUpdate?.updatedDefinition;
  if (storefrontOf(updated) !== input.access.storefront) {
    throw new Error(`${label}: metafieldDefinitionUpdate devolveu storefront=${updated?.access?.storefront ?? "(nada)"}, esperado ${input.access.storefront}`);
  }
  if (sccOf(updated) !== input.capabilities.smartCollectionCondition.enabled) {
    throw new Error(`${label}: metafieldDefinitionUpdate devolveu smartCollectionCondition=${sccOf(updated)}, esperado ${input.capabilities.smartCollectionCondition.enabled}`);
  }
  return updated;
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
