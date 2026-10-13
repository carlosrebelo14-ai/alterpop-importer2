import { tryPriceProduct, DEFAULT_MARGIN_PCT } from "./pricing.server.js";
import { buildLastPriceWrite } from "./lastPriceWrite.js";
import { recordLastPriceWrites } from "../../curation/curationQueue.server.js";

/**
 * Grava a última escrita de preço de um SKU logo a seguir a escrever o preço na Shopify.
 * Todo o código que escreve preço chama isto (ou recordLastPriceWrites com o registo
 * construído por buildLastPriceWrite) — scripts/tests/price-write-records.test.js falha se um
 * ficheiro escrever preço sem o fazer. Custo, PVPR e estado vêm da regra, a partir dos
 * valores do catálogo.
 *
 * SKU fora da fila: devolve `recorded: false` (o botão "aplicar aos publicados" só vê itens
 * da fila, por isso não há a que ligar o registo). Falha de leitura/escrita da fila lança.
 * @param {{ sku: string, price: number, distributorPrice: number|null|undefined, grossPrice: number|null|undefined,
 *   marginPct?: number|null, overridden?: boolean, source: 'publisher'|'reprice'|'backfill'|'import'|'reconcile',
 *   shop?: string|null }} args shop do histórico de preços (omissão: SHOPIFY_SHOP_URL)
 * @returns {Promise<{ recorded: boolean, write: object, historyError: string|null }>}
 */
export async function recordPriceWrite({ sku, price, distributorPrice, grossPrice, marginPct = null, overridden = false, source, shop = null }) {
  const calc = tryPriceProduct(distributorPrice, grossPrice, marginPct ?? DEFAULT_MARGIN_PCT);
  const write = buildLastPriceWrite({
    price,
    cost: calc.cost,
    pvpr: calc.pvpr,
    marginPct: overridden ? null : marginPct,
    priceStatus: overridden ? "OVERRIDE" : calc.priceStatus,
    source,
    rule: calc.rule,
  });
  const { recorded, historyError } = await recordLastPriceWrites([{ sku, write }], { shop });
  return { recorded: recorded.length > 0, write, historyError };
}
