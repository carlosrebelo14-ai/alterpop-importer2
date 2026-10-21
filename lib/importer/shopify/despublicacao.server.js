import { marcarDescontinuadoDespublicado } from "../../curation/curationQueue.server.js";

/**
 * O formato de DBG-16 aprovado em 21/10 pede DRAFT, e isso é productUpdate. O briefing de 17/09 (:24) proíbe
 * productUpdate, e a emenda a esse ponto fica para decisão explícita do arquiteto no PR.
 */
const PRODUCT_DRAFT = `
  mutation DespublicarDescontinuado($input: ProductInput!) {
    productUpdate(input: $input) {
      product { id status }
      userErrors { field message }
    }
  }
`;

/**
 * Põe um produto em DRAFT na Shopify. Nunca apaga: o URL e o histórico ficam.
 * @param {{ graphql: (query: string, vars?: any) => Promise<any> }} client
 * @param {string} productId
 */
export async function despublicarProdutoDraft(client, productId) {
  const data = await client.graphql(PRODUCT_DRAFT, { input: { id: productId, status: "DRAFT" } });
  const resultado = data?.productUpdate;
  const erros = resultado?.userErrors || [];
  if (erros.length) throw new Error(erros.map((e) => e.message).join("; "));
  if (resultado?.product?.status !== "DRAFT") throw new Error("A Shopify não confirmou o estado DRAFT");
  return resultado.product;
}

/**
 * Despublica os descontinuados, um a um. Antes de cada produto confirma o trinco de publicação (`aindaTem`). Um
 * produto que falha fica registado, e os outros continuam. Só chama a Shopify quando é chamada, e o script só a chama
 * com o OK do arquiteto.
 * @param {{
 *   client: { graphql: (query: string, vars?: any) => Promise<any> },
 *   itens: Array<{ sku: string, productId: string | null }>,
 *   aindaTem?: () => Promise<boolean>,
 *   marcar?: (sku: string) => Promise<unknown>,
 * }} p
 */
export async function despublicarDescontinuadosNaShopify({ client, itens, aindaTem, marcar = marcarDescontinuadoDespublicado }) {
  const ok = [];
  const falhas = [];
  for (const item of itens) {
    if (aindaTem && !(await aindaTem())) {
      falhas.push({ sku: item.sku, motivo: "trinco de publicação perdido: parado antes deste produto" });
      break;
    }
    if (!item.productId) {
      falhas.push({ sku: item.sku, motivo: "sem produto na Shopify" });
      continue;
    }
    try {
      await despublicarProdutoDraft(client, item.productId);
      const marcado = await marcar(item.sku);
      if (!marcado) {
        falhas.push({ sku: item.sku, motivo: "DRAFT ficou na Shopify, mas a fila já não tem o item publicado: não foi marcado" });
        continue;
      }
      ok.push(item.sku);
    } catch (err) {
      falhas.push({ sku: item.sku, motivo: err?.message || String(err) });
    }
  }
  return { ok, falhas };
}
