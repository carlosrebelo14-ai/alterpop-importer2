/**
 * Taxonomia de `alterpop.manufacturer_tier` (briefing backend, B5, 2026-09-15) — lista
 * fechada de 28 fabricantes, dada pelo arquiteto do lado da app. Quatro níveis:
 *
 *   ARTISAN    — 5 nomes, o mais alto
 *   SIGNATURE  — 8 nomes
 *   COLLECTOR  — 9 nomes
 *   CORE       — 6 nomes
 *
 * Fabricante fora desta lista fica SEM TIER — nunca cai em CORE por omissão (regra
 * explícita do briefing). O mapeamento real de escrita (par fabricante+line quando
 * existir, ex. (Bandai, S.H.Figuarts) -> COLLECTOR) é trabalho de B5, ainda por fazer;
 * isto é só a lista base, consumida por já pelo censo B3
 * (scripts/catalog/manufacturer-character-census.js) para medir cobertura contra o feed.
 *
 * Só dados, sem lógica — mesmo espírito de franchiseUniverses.js/franchiseLines.js.
 */

/** @typedef {"ARTISAN"|"SIGNATURE"|"COLLECTOR"|"CORE"} ManufacturerTier */

/** @type {Array<{ name: string, tier: ManufacturerTier }>} */
export const MANUFACTURER_TIERS = [
  { name: "JND Studios", tier: "ARTISAN" },
  { name: "Prime 1 Studio", tier: "ARTISAN" },
  { name: "XM Studios", tier: "ARTISAN" },
  { name: "Infinity Studio", tier: "ARTISAN" },
  { name: "Queen Studios", tier: "ARTISAN" },

  { name: "Hot Toys", tier: "SIGNATURE" },
  { name: "Sideshow", tier: "SIGNATURE" },
  { name: "Iron Studios", tier: "SIGNATURE" },
  { name: "Blitzway", tier: "SIGNATURE" },
  { name: "Threezero", tier: "SIGNATURE" },
  { name: "Gentle Giant", tier: "SIGNATURE" },
  { name: "Tweeterhead", tier: "SIGNATURE" },
  { name: "Mondo", tier: "SIGNATURE" },

  { name: "Kotobukiya", tier: "COLLECTOR" },
  { name: "Good Smile Company", tier: "COLLECTOR" },
  { name: "MegaHouse", tier: "COLLECTOR" },
  { name: "Tamashii Nations", tier: "COLLECTOR" },
  { name: "Alter", tier: "COLLECTOR" },
  { name: "Aniplex", tier: "COLLECTOR" },
  { name: "NECA", tier: "COLLECTOR" },
  { name: "Mezco", tier: "COLLECTOR" },
  { name: "McFarlane Toys", tier: "COLLECTOR" },

  { name: "Banpresto", tier: "CORE" },
  { name: "SEGA", tier: "CORE" },
  { name: "Funko", tier: "CORE" },
  { name: "Jakks Pacific", tier: "CORE" },
  { name: "Mattel", tier: "CORE" },
  { name: "Hasbro", tier: "CORE" },
];
