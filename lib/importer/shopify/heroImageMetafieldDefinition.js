import { ensureMetafieldDefinition } from "./metafieldSetup.js";

/**
 * Definição de metafield `alterpop.hero_image` — Collection, imagem wide dedicada ao
 * hero da Universe Room (briefing "Universe Room, imagem de capa", 17/09/2026).
 *
 * `collection.image` já está reservado (C3, briefing-carlos-14-09-2026) à imagem
 * quadrada de fundo escuro das tiles do Explore Universes e do mega-menu — um campo,
 * dois formatos incompatíveis (sintoma medido na coleção one-piece: logo quadrado
 * esticado no banner wide, texto ilegível). Este campo dissocia o hero (wide, 60vw no
 * desktop) desse uso.
 *
 * Curadoria manual, sem sinal no feed OcioStock — mesmo modelo do Character
 * (alterpop.character / alterpop.characters, ver characterMetaobjectSetup.js). Este
 * módulo só cria a definição; nenhum código de sync escreve valores neste campo.
 *
 * `pin: true`: 65 edições manuais do Carlos, sem ficar atrás de um clique extra em cada
 * coleção. Desvio deliberado ao precedente do Character, cujos metafields são escritos
 * pela app.
 *
 * `access.admin` NÃO se declara aqui — de propósito, ao fim de duas tentativas erradas
 * a 18/09/2026:
 *   1. `admin: "PUBLIC_READ_WRITE"` → erro de validação de tipo (`MetafieldAdminAccessInput`
 *      só aceita MERCHANT_READ / MERCHANT_READ_WRITE).
 *   2. `admin: "MERCHANT_READ_WRITE"` → userError: "Setting this access control is not
 *      permitted. It must be one of [public_read_write]".
 * Resolução (shopify.dev/docs/apps/build/metafields/definitions, secção Access
 * control): `alterpop` é namespace livre (não `$app:`), logo esta definição é
 * merchant-owned. Para essas, o merchant tem sempre controlo total — o admin access é
 * forçado a public_read_write e DECLARÁ-LO É RECUSADO, seja qual for o valor. Só uma
 * app pode declarar `access.admin`, e só no namespace reservado dela (`MERCHANT_READ` /
 * MERCHANT_READ_WRITE`, os únicos valores do enum de escrita). `alterpop.characters`
 * mostra `PUBLIC_READ_WRITE` por leitura sem ninguém o ter escrito — é o default de
 * definição merchant-owned, não um valor declarável. Não confundir o enum de leitura
 * (`MetafieldAdminAccess`, 5 valores) com o de escrita (`MetafieldAdminAccessInput`, 2
 * valores, só para apps em namespace próprio).
 *
 * Criada via scripts/setup/ensure-hero-image-metafield.js (metafieldDefinitionCreate).
 */

/** @type {import('./metafieldSetup.js').MetafieldDefinitionShape} */
export const ALTERPOP_HERO_IMAGE_DEFINITION = {
  namespace: "alterpop",
  key: "hero_image",
  name: "Hero image",
  description:
    "Imagem wide (16:9 ou 21:9, mínimo 2400px, zona segura de texto no terço esquerdo) para o hero da Universe Room. Curadoria manual, sem sinal no feed OcioStock. Distinta de collection.image (quadrada, tiles Explore Universes / mega-menu).",
  ownerType: "COLLECTION",
  type: "file_reference",
  validations: [{ name: "file_type_options", value: JSON.stringify(["Image"]) }],
  access: { storefront: "PUBLIC_READ" },
  pin: true,
};

/**
 * @param {import('../shopifyClient.js').ShopifyClient} client
 */
export async function ensureHeroImageMetafieldDefinition(client) {
  return ensureMetafieldDefinition(client, ALTERPOP_HERO_IMAGE_DEFINITION);
}

/** GID da definição alterpop.hero_image em jyr17t-wr.myshopify.com (criada 18/09/2026
 *  via ensure-hero-image-metafield.js --execute). Reconfirmar por query se a loja for
 *  recriada — não assumir estável entre ambientes. */
export const ALTERPOP_HERO_IMAGE_DEFINITION_GID =
  "gid://shopify/MetafieldDefinition/1533876732234";
