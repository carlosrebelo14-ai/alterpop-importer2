/**
 * DBG-16. Lógica pura dos descontinuados: quem já não está no feed, e que substitutos oferecer. Sem BD e sem Shopify.
 */

/** Decisão 44 (emenda ao ponto 7 da Decisão 34): 3 ciclos seguidos sem aparecer no feed. Igual ao limiar de revisão. */
export const CICLOS_PARA_DESPUBLICAR = 3;
/** Decisão 34, ponto 8: mais de 5% dos publicados ausentes de uma vez indica feed truncado. Nada é listado. */
export const FRACAO_MAXIMA_AUSENTES = 0.05;
/** Formato aprovado em 21/10: preço a mais ou menos 30%. */
export const VARIACAO_DE_PRECO = 0.3;
/** Formato aprovado em 21/10: até 3 substitutos por produto. */
export const MAX_SUBSTITUTOS = 3;

/**
 * alterpop.franchise e alterpop.format são metafields de lista: o valor chega como texto JSON, por exemplo ["Nome"].
 * Devolve o primeiro nome, ou null.
 * @param {string | null | undefined} valor
 * @returns {string | null}
 */
export function valorDeMetafield(valor) {
  if (!valor) return null;
  const texto = String(valor).trim();
  if (!texto.startsWith("[")) return texto || null;
  try {
    const lista = JSON.parse(texto);
    const primeiro = Array.isArray(lista) ? lista.find((v) => typeof v === "string" && v.trim()) : null;
    return primeiro ? primeiro.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Publicados que faltam no feed há `ciclos` ciclos seguidos. Um SKU já despublicado sai da conta: já não está vivo
 * na Shopify. Um SKU ignorado continua vivo, por isso conta no guarda, mas não aparece na lista.
 * @param {{
 *   items: Array<{ sku: string, metadata?: Record<string, any> }>,
 *   rastreio: Map<string, { missingCycles: number, lastSeenAt: Date | string | null, franchises?: string[] }>,
 *   presentes: Set<string>,
 *   ciclos?: number,
 *   fracaoMaxima?: number,
 * }} p
 */
export function classificarPublicadosAusentes({
  items,
  rastreio,
  presentes,
  ciclos = CICLOS_PARA_DESPUBLICAR,
  fracaoMaxima = FRACAO_MAXIMA_AUSENTES,
}) {
  const vivos = items.filter((item) => !item.metadata?.despublicadoEm);
  const ausentesAgora = vivos.filter((item) => !presentes.has(item.sku));

  if (vivos.length && ausentesAgora.length / vivos.length > fracaoMaxima) {
    return {
      abortado: true,
      motivo: `${ausentesAgora.length} de ${vivos.length} publicados ausentes do feed (acima de ${Math.round(fracaoMaxima * 100)}%). Feed possivelmente truncado: nada é listado.`,
      ausentesAgora: ausentesAgora.length,
      itens: [],
    };
  }

  const itens = ausentesAgora
    .filter((item) => !item.metadata?.descontinuadoIgnoradoEm)
    .filter((item) => (rastreio.get(item.sku)?.missingCycles ?? 0) >= ciclos)
    .map((item) => {
      const registo = rastreio.get(item.sku);
      return {
        sku: item.sku,
        missingCycles: registo.missingCycles,
        saiuEm: registo.lastSeenAt ? new Date(registo.lastSeenAt).toISOString() : null,
      };
    });

  return { abortado: false, motivo: null, ausentesAgora: ausentesAgora.length, itens };
}

/**
 * Substitutos de um descontinuado: mesma franquia e mesmo formato, preço a mais ou menos 30%, com stock, sem entrada
 * na fila, por ordem de preço mais próximo, até `max`.
 * @param {{
 *   referencia: { sku: string, franchise: string | null, format: string | null, netPrice: number | null },
 *   candidatos: Array<{ sku: string, resolvedFranchise: string | null, resolvedFormat: string | null, stock: number, netPrice: number | null }>,
 *   ocupados: Set<string>,
 *   max?: number,
 *   variacao?: number,
 * }} p
 * @returns {{ substitutos: Array<Record<string, any>>, motivo: string | null }}
 */
export function escolherSubstitutos({
  referencia,
  candidatos,
  ocupados,
  max = MAX_SUBSTITUTOS,
  variacao = VARIACAO_DE_PRECO,
}) {
  if (!referencia.franchise) return { substitutos: [], motivo: "sem franquia de referência" };
  if (!referencia.format) return { substitutos: [], motivo: "sem formato de referência" };
  const preco = Number(referencia.netPrice);
  if (!Number.isFinite(preco) || preco <= 0) return { substitutos: [], motivo: "sem preço de referência" };

  const limite = preco * variacao;
  const substitutos = candidatos
    .filter((c) => c.sku !== referencia.sku)
    .filter((c) => !ocupados.has(c.sku))
    .filter((c) => Number(c.stock) > 0)
    .filter((c) => c.resolvedFranchise === referencia.franchise)
    .filter((c) => c.resolvedFormat === referencia.format)
    .filter((c) => Number.isFinite(Number(c.netPrice)) && Number(c.netPrice) > 0)
    .map((c) => ({ ...c, diferenca: Math.abs(Number(c.netPrice) - preco) }))
    .filter((c) => c.diferenca <= limite)
    .sort((a, b) => a.diferenca - b.diferenca || a.sku.localeCompare(b.sku))
    .slice(0, max);

  return { substitutos, motivo: null };
}
