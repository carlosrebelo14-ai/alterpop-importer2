/**
 * Definição de metafield `alterpop.franchise` — Fase 5 da normalização de franquias.
 *
 * Guarda o universo resolvido pelo franchiseResolver (nome canónico da tabela dos 41 em
 * franchiseUniverses.js). Um valor por produto; o tipo é lista só para o caso raro de
 * crossover genuíno decidido à mão.
 *
 * `smartCollectionCondition` ligado: é o que permite às coleções Universe do tema usarem
 * a regra `alterpop.franchise EQUALS <nome>` (metafieldDefinitionCreate/Update →
 * capabilities.smartCollectionCondition.enabled).
 *
 * ⚠️ A doc da Shopify (use-metafield-capabilities) lista só o `single_line_text_field`
 * ESCALAR como suportado para smart collections, não a variante `list.*`. Verificado
 * empiricamente em jyr17t-wr a 2026-09-06: a API ACEITA a capability em
 * `list.single_line_text_field` e devolve `eligible: true, enabled: true`. Falta
 * confirmar que uma regra `EQUALS` real casa contra os valores da lista — isso vê-se no
 * dry-run da Fase 7 (ou no conector). Se não casar, o plano B é `collectionAddProducts`.
 *
 * Criada manualmente via Admin API (metafieldDefinitionCreate) a 2026-09-06, não por
 * código de sync. Este módulo existe para documentar a forma e o id, e para a Fase 7
 * poder resolver o `conditionObjectId` da regra.
 */

/** @type {import('./metafieldSetup.js').MetafieldDefinitionShape} */
export const ALTERPOP_FRANCHISE_DEFINITION = {
  namespace: "alterpop",
  key: "franchise",
  name: "Franchise / Universe",
  description:
    "Universo do produto, atribuído pelo franchiseResolver do importer (refs do feed OcioStock + título). Um valor por produto. Alimenta as coleções Universe do tema via regra alterpop.franchise EQUALS <nome>.",
  ownerType: "PRODUCT",
  type: "list.single_line_text_field",
  pin: true,
  capabilities: { smartCollectionCondition: { enabled: true } },
};

/** GID da definição em jyr17t-wr.myshopify.com (criada 2026-09-06). Reconfirmar por
 *  query se a loja for recriada — não assumir estável entre ambientes. */
export const ALTERPOP_FRANCHISE_DEFINITION_GID =
  "gid://shopify/MetafieldDefinition/1520603857226";

/**
 * Definição de metafield `alterpop.line` — ENTREGA 2 (2026-09-10).
 *
 * Sub-divisão DENTRO de um universo (ex.: "The Mandalorian" dentro de "Star Wars"). O
 * produto mantém alterpop.franchise = <universo>; alterpop.line é classificação
 * adicional. Um valor por produto (tipo lista só por simetria com franchise).
 *
 * `smartCollectionCondition` ligado — a coleção Line usa a regra
 * `alterpop.line EQUALS <nome>` com templateSuffix "line". Mesma verificação empírica
 * que a de franchise (list.single_line_text_field aceita a capability em jyr17t-wr).
 *
 * Criada via scripts/catalog/line-metafield-definition.js (metafieldDefinitionCreate).
 */
/** @type {import('./metafieldSetup.js').MetafieldDefinitionShape} */
export const ALTERPOP_LINE_DEFINITION = {
  namespace: "alterpop",
  key: "line",
  name: "Line",
  description:
    "Linha/sub-colecção dentro de um universo (ex.: The Mandalorian dentro de Star Wars). Atribuída pelo franchiseResolver do importer. Um valor por produto. Alimenta as coleções Line do tema via regra alterpop.line EQUALS <nome>.",
  ownerType: "PRODUCT",
  type: "list.single_line_text_field",
  pin: true,
  capabilities: { smartCollectionCondition: { enabled: true } },
};

/** GID da definição alterpop.line em jyr17t-wr.myshopify.com (criada 2026-09-10 via
 *  line-metafield-definition.js; type list.single_line_text_field, smartCollectionCondition
 *  enabled: true — a capability funciona no tipo lista, tal como em alterpop.franchise).
 *  Reconfirmar por query se a loja for recriada. */
export const ALTERPOP_LINE_DEFINITION_GID =
  "gid://shopify/MetafieldDefinition/1523245318474";

/**
 * Definição de metafield `alterpop.format` — Tarefa 35 (Decisão 18), depende da
 * Tarefa 34 (formatExtractor.server.js).
 *
 * Formato de produto (Figure, Keychain, Backpack, Plush, Puzzle, Mug, Blind Box),
 * derivado do título pelo formatExtractor. Um valor por produto (tipo lista por
 * simetria com franchise/line — mesma convenção, mesma capability).
 *
 * `smartCollectionCondition` ligado — mesma verificação empírica que franchise/line
 * (list.single_line_text_field aceita a capability em jyr17t-wr).
 *
 * Criada via scripts/catalog/format-metafield-definition.js (metafieldDefinitionCreate).
 */
/** @type {import('./metafieldSetup.js').MetafieldDefinitionShape} */
export const ALTERPOP_FORMAT_DEFINITION = {
  namespace: "alterpop",
  key: "format",
  name: "Format",
  description:
    "Formato do produto (Figure, Keychain, Backpack, Plush, Puzzle, Mug, Blind Box), atribuído pelo formatExtractor do importer a partir do título. Um valor por produto.",
  ownerType: "PRODUCT",
  type: "list.single_line_text_field",
  pin: true,
  capabilities: { smartCollectionCondition: { enabled: true } },
};

/** GID da definição alterpop.format em jyr17t-wr.myshopify.com (criada 2026-09-11 via
 *  format-metafield-definition.js; type list.single_line_text_field,
 *  smartCollectionCondition enabled: true). Reconfirmar por query se a loja for
 *  recriada. */
export const ALTERPOP_FORMAT_DEFINITION_GID =
  "gid://shopify/MetafieldDefinition/1525101363530";
