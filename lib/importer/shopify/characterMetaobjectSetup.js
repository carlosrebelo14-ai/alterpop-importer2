import { ensureMetafieldDefinition } from "./metafieldSetup.js";

/**
 * Definição do metaobject `character` — resposta da app ao briefing frontend de
 * 16/09/2026 (claude/resposta-app-briefing-16-09-2026.md), secção 3/piloto de 17/09.
 * urlHandle "characters" é a decisão de 15/09 (nav não pode dizer "Characters"; o URL
 * pode). createRedirects true para poder mudar o urlHandle depois sem partir links.
 */
export const CHARACTER_METAOBJECT_TYPE = "character";

export const CHARACTER_METAOBJECT_DEFINITION = {
  type: CHARACTER_METAOBJECT_TYPE,
  name: "Character",
  displayNameKey: "title",
  access: {
    storefront: "PUBLIC_READ",
  },
  capabilities: {
    publishable: { enabled: true },
    onlineStore: {
      enabled: true,
      data: { urlHandle: "characters", createRedirects: true },
    },
  },
  fieldDefinitions: [
    {
      key: "title",
      name: "Título",
      type: "single_line_text_field",
      required: true,
    },
    {
      key: "image",
      name: "Imagem",
      type: "file_reference",
      required: false,
      validations: [{ name: "file_type_options", value: JSON.stringify(["Image"]) }],
    },
    {
      key: "universe",
      name: "Universo",
      type: "list.collection_reference",
      required: true,
    },
    {
      key: "products",
      name: "Produtos",
      type: "list.product_reference",
      required: true,
      // Limite de 128 itens em list.product_reference — acima disso a API rejeita com
      // erro visível em vez da app truncar em silêncio (correção da secção 3).
      validations: [{ name: "list.max", value: "128" }],
    },
  ],
};

/**
 * `metafieldDefinitionCreate` rejeita a validação `metaobject_definition_type` com
 * "Validations require that you select a metaobject" apesar de `metafieldDefinitionTypes`
 * a listar como suportada para list.metaobject_reference — na prática exige o GID
 * concreto (`metaobject_definition_id`). Por isso estes metafields só se criam depois
 * da definição `character` já existir (ver ensureCharacterMetafieldDefinitions).
 * @param {string} metaobjectDefinitionId GID de MetaobjectDefinition
 */
function characterReferenceValidations(metaobjectDefinitionId) {
  return [{ name: "metaobject_definition_id", value: metaobjectDefinitionId }];
}

export function characterProductMetafieldDefinition(metaobjectDefinitionId) {
  return {
    namespace: "alterpop",
    key: "character",
    name: "Character",
    description: "Characters publicados a que este produto pertence (ver metaobject character).",
    ownerType: "PRODUCT",
    type: "list.metaobject_reference",
    validations: characterReferenceValidations(metaobjectDefinitionId),
    access: { storefront: "PUBLIC_READ" },
  };
}

export function characterCollectionMetafieldDefinition(metaobjectDefinitionId) {
  return {
    namespace: "alterpop",
    key: "characters",
    name: "Characters",
    description: "Characters publicados deste universo, ordenados por número de produtos (maior primeiro).",
    ownerType: "COLLECTION",
    type: "list.metaobject_reference",
    validations: characterReferenceValidations(metaobjectDefinitionId),
    access: { storefront: "PUBLIC_READ" },
  };
}

const METAOBJECT_DEFINITION_BY_TYPE_QUERY = `
  query CharacterMetaobjectDefinitionByType($type: String!) {
    metaobjectDefinitionByType(type: $type) {
      id
      type
      fieldDefinitions { key type { name } }
    }
  }
`;

const METAOBJECT_DEFINITION_CREATE = `
  mutation CharacterMetaobjectDefinitionCreate($definition: MetaobjectDefinitionCreateInput!) {
    metaobjectDefinitionCreate(definition: $definition) {
      metaobjectDefinition {
        id
        type
        fieldDefinitions { key type { name } }
      }
      userErrors { field message }
    }
  }
`;

/**
 * Sonda só de leitura — nunca escreve. Serve para confirmar, antes de qualquer escrita,
 * que a sessão da app tem `read_metaobject_definitions` (probe pedido na resposta de
 * 17/09 antes de criar a definição).
 * @param {import('../shopifyClient.js').ShopifyClient} client
 */
export async function probeMetaobjectDefinitionsReadAccess(client) {
  await client.graphql(`query CharacterProbe { metaobjectDefinitions(first: 1) { nodes { type } } }`);
  return true;
}

/**
 * Garante a definição do metaobject `character` (cria via API se ainda não existir).
 * Idempotente — verifica por `type` antes de criar, nunca duplica.
 * @param {import('../shopifyClient.js').ShopifyClient} client
 */
export async function ensureCharacterMetaobjectDefinition(client) {
  const existing = await client.graphql(METAOBJECT_DEFINITION_BY_TYPE_QUERY, {
    type: CHARACTER_METAOBJECT_TYPE,
  });
  const found = existing.metaobjectDefinitionByType;
  if (found?.id) {
    return { created: false, definition: found };
  }

  const data = await client.graphql(METAOBJECT_DEFINITION_CREATE, {
    definition: CHARACTER_METAOBJECT_DEFINITION,
  });

  const errors = data.metaobjectDefinitionCreate?.userErrors || [];
  if (errors.length) {
    throw new Error(errors.map((e) => `${e.field?.join(".")}: ${e.message}`).join("; "));
  }

  const created = data.metaobjectDefinitionCreate?.metaobjectDefinition;
  if (!created?.id) {
    throw new Error("metaobjectDefinitionCreate não devolveu definição");
  }

  return { created: true, definition: created };
}

/**
 * Garante as duas definições de metafield (`alterpop.character` no produto,
 * `alterpop.characters` na coleção). Idempotente. Requer o GID da definição
 * `character` já criada (ver ensureCharacterMetaobjectDefinition).
 * @param {import('../shopifyClient.js').ShopifyClient} client
 * @param {string} metaobjectDefinitionId
 */
export async function ensureCharacterMetafieldDefinitions(client, metaobjectDefinitionId) {
  const product = await ensureMetafieldDefinition(
    client,
    characterProductMetafieldDefinition(metaobjectDefinitionId)
  );
  const collection = await ensureMetafieldDefinition(
    client,
    characterCollectionMetafieldDefinition(metaobjectDefinitionId)
  );
  return { product, collection };
}
