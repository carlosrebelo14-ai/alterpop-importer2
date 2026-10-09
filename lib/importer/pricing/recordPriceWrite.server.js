import { tryPriceProduct } from "./pricing.server.js";
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
 *   marginPct?: number|null, overridden?: boolean, source: 'publisher'|'reprice'|'backfill'|'import'|'reconcile' }} args
 * @returns {Promise<{ recorded: boolean, write: object }>}
 */
export async function recordPriceWrite({ sku, price, distributorPrice, grossPrice, marginPct = null, overridden = false, source }) {
  const calc = tryPriceProduct(distributorPrice, grossPrice, marginPct ?? 40);
  const write = buildLastPriceWrite({
    price,
    cost: calc.cost,
    pvpr: calc.pvpr,
    marginPct: overridden ? null : marginPct,
    priceStatus: overridden ? "OVERRIDE" : calc.priceStatus,
    source,
  });
  const { recorded } = await recordLastPriceWrites([{ sku, write }]);
  return { recorded: recorded.length > 0, write };
}
