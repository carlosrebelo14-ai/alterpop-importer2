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
