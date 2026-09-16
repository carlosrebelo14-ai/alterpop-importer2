/**
 * B5 — resolver de `alterpop.manufacturer_tier` (briefing backend, 15/09/2026).
 *
 * Os quatro níveis estão completos como dados em manufacturerTiers.js (28 nomes). Este
 * módulo é a lógica que os aplica a um `vendor` do feed: normaliza (o feed escreve em
 * maiúsculas, a taxonomia em title case) e procura na tabela.
 *
 * SÓ o nível fabricante-sozinho está implementado. A tabela de pares (fabricante, line)
 * do briefing — ex. (Bandai, S.H.Figuarts) -> COLLECTOR vs (Bandai, —) -> CORE — precisa
 * de `alterpop.manufacturer_line` (B6), que ainda não foi construído: sem dado de line
 * medido, não há par nenhum para mapear. Quando B6 existir, este resolver ganha uma
 * segunda tabela consultada primeiro (par vence sozinho), sem mudar o comportamento do
 * que já funciona.
 *
 * ARTISAN e SIGNATURE ATIVOS NO CÓDIGO, VAZIOS NO FEED DE HOJE — NÃO É BUG, NÃO É MORTO.
 * Medido em 15/09/2026 (censo B3): 0 de 5 nomes ARTISAN aparecem no feed da OcioStock;
 * SIGNATURE só tem Gentle Giant, com 2 produtos. Não são níveis "para o futuro" no
 * sentido de especulativo — são o desenho correto da taxonomia, à espera de outro
 * fornecedor ou de mais produto do Gentle Giant. NÃO REMOVER nem "simplificar" para só
 * COLLECTOR/CORE só porque hoje estão vazios ou quase vazios — a decisão foi deliberada
 * (briefing 15/09), não esquecimento.
 *
 * Fabricante fora da lista de 28 fica SEM TIER (null). Nunca cai em CORE por omissão —
 * regra explícita do briefing.
 */
import { MANUFACTURER_TIERS } from "./manufacturerTiers.js";

/** Só dados, sem lógica extra — mesmo helper normalizador usado em toda a app para
 *  comparar texto insensível a caixa/acentos/pontuação (universeCollections.server.js). */
function normalizeForMatch(label) {
  return String(label || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join("");
}

const TIER_POR_VENDOR_NORM = new Map(MANUFACTURER_TIERS.map((m) => [normalizeForMatch(m.name), m.tier]));

/**
 * @param {string|null|undefined} vendor
 * @returns {import('./manufacturerTiers.js').ManufacturerTier|null} tier, ou null se o
 *  fabricante não estiver na taxonomia dos 28 — nunca CORE por omissão.
 */
export function resolveManufacturerTier(vendor) {
  const norm = normalizeForMatch(vendor);
  if (!norm) return null;
  return TIER_POR_VENDOR_NORM.get(norm) ?? null;
}

/**
 * "Filtro de coleccionáveis" da curadoria (briefing 15/09/2026, B1) — só COLLECTOR e
 * CORE. ARTISAN e SIGNATURE ficam FORA deste filtro por desenho: estão vazios/quase
 * vazios no feed de hoje (ver nota acima), e incluí-los no filtro não mudaria a piscina
 * de curadoria na prática, só complicava a leitura da regra. Quando tiverem produto a
 * sério, é uma decisão à parte se entram no filtro, não uma consequência automática de
 * estarem na taxonomia.
 */
const TIERS_COLECIONAVEIS = new Set(["COLLECTOR", "CORE"]);

/** @param {string|null|undefined} vendor */
export function isCollectibleVendor(vendor) {
  const tier = resolveManufacturerTier(vendor);
  return tier != null && TIERS_COLECIONAVEIS.has(tier);
}
