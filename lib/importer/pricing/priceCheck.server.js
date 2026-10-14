/**
 * Verificação de preços para a troca para PRICE_MODE=NET (Decisão 31). Só leitura: lê na Shopify
 * `shop.taxesIncluded` e os preços dos publicados e compara com a regra NET, pelo mesmo caminho
 * da pré-visualização "Pré-visualizar regra NET" (buildRepricePreview). Devolve só CONTAGENS,
 * nunca SKUs, handles nem preços, para poder ir para logs públicos.
 */
import { buildRepricePreview } from "../shopify/publishedReprice.server.js";

const SHOP_TAXES = `query PriceCheckShop { shop { taxesIncluded } }`;

/** Degraus da diferença percentual absoluta entre o preço da loja e o proposto. */
export const DIFF_BANDS = Object.freeze([
  ["ate_1", 1],
  ["1_a_5", 5],
  ["5_a_15", 15],
  ["acima_15", Infinity],
]);

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Motivo da exclusão a partir do texto (funciona com código antigo e novo, sem `ignoreCode`). */
export function ignoreKind(row) {
  if (row.ignoreCode) return row.ignoreCode;
  const r = String(row.reason || "");
  if (/override da curadoria/.test(r)) return "manualOverride";
  if (/^preço manual preservado/.test(r)) return "manualDetected";
  if (/sync_locked/.test(r)) return "locked";
  if (/sem última escrita/.test(r)) return "noRecord";
  return "other";
}

/**
 * @param {{ shop: string, client: { graphql: Function }, deps?: object }} args deps: as de buildRepricePreview (testes)
 */
export async function runPriceCheck({ shop, client, deps = {} }) {
  const taxes = await client.graphql(SHOP_TAXES);
  const taxesIncluded = taxes?.shop?.taxesIncluded;
  if (typeof taxesIncluded !== "boolean") throw new Error("shop.taxesIncluded não veio da Shopify");

  const preview = await buildRepricePreview({ shop, client, mode: "rule", rule: "NET", includeManual: false, deps });
  const rows = preview.rows;
  const update = rows.filter((r) => r.category === "update");
  const bands = Object.fromEntries(DIFF_BANDS.map(([k]) => [k, 0]));
  for (const r of update) {
    const abs = Math.abs(r.diffPct);
    const [key] = DIFF_BANDS.find(([, max]) => abs <= max);
    bands[key] += 1;
  }
  const ignoredBy = { manualOverride: 0, manualDetected: 0, locked: 0, noRecord: 0, other: 0 };
  for (const r of rows.filter((x) => x.category === "ignored")) ignoredBy[ignoreKind(r)] += 1;

  return {
    serverRule: preview.serverRule,
    taxesIncluded,
    published: preview.publishedTotal,
    conformesNet: preview.publishedTotal - preview.outdatedTotal,
    aAtualizar: update.length,
    sobem: update.filter((r) => r.diff > 0).length,
    descem: update.filter((r) => r.diff < 0).length,
    medianaDiffPct: update.length ? Math.round(median(update.map((r) => r.diffPct)) * 10) / 10 : null,
    bands,
    foraPorPrecoManual: ignoredBy.manualOverride + ignoredBy.manualDetected,
    manualOverride: ignoredBy.manualOverride,
    manualDetetado: ignoredBy.manualDetected,
    trancados: ignoredBy.locked,
    semRegisto: ignoredBy.noRecord,
    outrosIgnorados: ignoredBy.other,
    falhados: rows.filter((r) => r.category === "failed").length,
    naoEncontrados: rows.filter((r) => r.category === "notFound").length,
  };
}

/** Linhas `PC: chave=valor` (uma por contagem) para o resumo do workflow. */
export function formatPriceCheck(r) {
  const lines = [
    ["regra_servidor", r.serverRule],
    ["impostos_incluidos", r.taxesIncluded],
    ["publicados", r.published],
    ["conformes_net", r.conformesNet],
    ["a_atualizar", r.aAtualizar],
    ["sobem", r.sobem],
    ["descem", r.descem],
    ["mediana_diff_pct", r.medianaDiffPct ?? "n/a"],
    ...Object.entries(r.bands).map(([k, v]) => [`banda_${k}`, v]),
    ["fora_preco_manual", r.foraPorPrecoManual],
    ["manual_override", r.manualOverride],
    ["manual_detetado", r.manualDetetado],
    ["trancados", r.trancados],
    ["sem_registo", r.semRegisto],
    ["outros_ignorados", r.outrosIgnorados],
    ["falhados", r.falhados],
    ["nao_encontrados", r.naoEncontrados],
  ];
  return lines.map(([k, v]) => `PC: ${k}=${v}`);
}
