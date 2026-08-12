/**
 * Score de confiança de dados (0-100) por produto do catálogo — item 1 do pacote de
 * melhorias criativas de 2026-08-12. Combina cinco sinais já existentes em
 * CatalogProduct, cada um "presente/ausente" (sem gradação), pesados por impacto no
 * catálogo publicado:
 *
 *  - titleSource "supplier" (25): título já veio traduzido do fornecedor — o maior
 *    risco de qualidade percebida pelo cliente é um título em espanhol/spanglish.
 *  - categoryMain resolvida (25): sem categoria o produto fica invisível nas coleções
 *    e no menu — tão crítico como o título.
 *  - dimensions real (20): necessário para custos de envio corretos; ~31% do feed não
 *    traz este dado (ver comentário no schema Prisma), por isso pesa menos que
 *    título/categoria mas mais que os dois campos seguintes.
 *  - weightKg presente (15): idem, mas com fallback mais tolerável (heurística de peso
 *    por categoria já existe noutros pontos do pipeline).
 *  - hsCode presente (15): só relevante para exportação/aduaneira; ~9,3% sem valor.
 *
 * A soma dá 100. Pesos escolhidos a dedo (não há dado histórico de conversão para
 * calibrar) — ajustar aqui se a curadoria mostrar que outro sinal importa mais.
 *
 * IMPORTANTE: `CONFIDENCE_SCORE_SQL` replica esta fórmula em SQL puro (usado para
 * ordenar/filtrar ao nível da BD, ver catalogProductsDb.server.js). Qualquer alteração
 * aos pesos abaixo tem de ser espelhada nessa string — não há forma de partilhar a
 * lógica entre JS e SQLite sem um custo de manutenção pior do que a duplicação.
 */

export const CONFIDENCE_WEIGHTS = {
  titleSource: 25,
  category: 25,
  dimensions: 20,
  weightKg: 15,
  hsCode: 15,
};

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * @param {{ titleSource?: string|null, categoryMain?: string|null, dimensions?: string|null, weightKg?: number|null, hsCode?: string|null }} product
 * @returns {{ score: number, level: "high"|"medium"|"low", breakdown: Record<string, boolean> }}
 */
export function computeDataConfidenceScore(product = {}) {
  const breakdown = {
    titleSource: product.titleSource === "supplier",
    category: hasText(product.categoryMain),
    dimensions: hasText(product.dimensions),
    weightKg: product.weightKg != null && Number.isFinite(Number(product.weightKg)),
    hsCode: hasText(product.hsCode),
  };

  let score = 0;
  for (const key of Object.keys(CONFIDENCE_WEIGHTS)) {
    if (breakdown[key]) score += CONFIDENCE_WEIGHTS[key];
  }

  const level = score >= 75 ? "high" : score >= 45 ? "medium" : "low";
  return { score, level, breakdown };
}

/**
 * Fragmento SQL (SQLite) que calcula o mesmo score, para uso em ORDER BY / WHERE
 * sobre CatalogProduct (alias obrigatório "p"). Ver aviso de sincronização no
 * cabeçalho do ficheiro.
 */
export const CONFIDENCE_SCORE_SQL = `(
  (CASE WHEN p.titleSource = 'supplier' THEN ${CONFIDENCE_WEIGHTS.titleSource} ELSE 0 END) +
  (CASE WHEN p.categoryMain IS NOT NULL AND TRIM(p.categoryMain) != '' THEN ${CONFIDENCE_WEIGHTS.category} ELSE 0 END) +
  (CASE WHEN p.dimensions IS NOT NULL AND TRIM(p.dimensions) != '' THEN ${CONFIDENCE_WEIGHTS.dimensions} ELSE 0 END) +
  (CASE WHEN p.weightKg IS NOT NULL THEN ${CONFIDENCE_WEIGHTS.weightKg} ELSE 0 END) +
  (CASE WHEN p.hsCode IS NOT NULL AND TRIM(p.hsCode) != '' THEN ${CONFIDENCE_WEIGHTS.hsCode} ELSE 0 END)
)`;
