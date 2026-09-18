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
 * `access.admin` explícito como PUBLIC_READ_WRITE (em vez de deixar o omisso, que na
 * prática já resulta nisto — confirmado por query em alterpop.characters, 18/09/2026):
 * este campo existe só para edição manual do Carlos, ao contrário de franchise/line/
 * format/manufacturer_line, que a app escreve. `pin: true` pelo mesmo motivo — 65
 * edições manuais, sem ficar atrás de um clique extra em cada coleção. Desvio
 * deliberado ao precedente do Character, cujos metafields são escritos pela app.
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
  access: { storefront: "PUBLIC_READ", admin: "PUBLIC_READ_WRITE" },
  pin: true,
};

/**
 * @param {import('../shopifyClient.js').ShopifyClient} client
 */
export async function ensureHeroImageMetafieldDefinition(client) {
  return ensureMetafieldDefinition(client, ALTERPOP_HERO_IMAGE_DEFINITION);
}

/** GID da definição alterpop.hero_image em jyr17t-wr.myshopify.com. Preencher depois de
 *  correr scripts/setup/ensure-hero-image-metafield.js --execute e o script devolver o
 *  id. Reconfirmar por query se a loja for recriada — não assumir estável entre
 *  ambientes. */
export const ALTERPOP_HERO_IMAGE_DEFINITION_GID = null;
