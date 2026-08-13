/**
 * Motivos reais gerados por evaluateCurationRules() (lib/importer/curation/
 * visibilityGatekeeper.js) — o gate que corre em cada produto indexado; ordem e
 * volumes confirmados contra a fila de curadoria em produção (2026-08-12,
 * 29.601 itens): brand_not_allowed 16.651, approved 9.097, elite_brand_not_premium
 * 2.100, blocked_category 1.224, priority_franchise_exception 433. Os "structured_*"
 * vêm de evaluateStructuredCatalogFilter() (caminho legado/paralelo, muito menos
 * usado hoje — ~100 itens no total) mas mantidos porque ainda aparecem. A
 * comparação ignora o sufixo ":valor" dos motivos parametrizados.
 *
 * Partilhado entre FacetedSearchSidebar.jsx (filtro por motivo) e app._index.jsx
 * (motivo inline por baixo do badge de Estado na Curadoria).
 */
export const REASON_OPTIONS = [
  { value: "", label: "Todos" },
  { value: "brand_not_allowed", label: "Marca não permitida" },
  { value: "approved", label: "Aprovado automaticamente (gate)" },
  { value: "elite_brand_not_premium", label: "Marca elite, mas não premium" },
  { value: "blocked_category", label: "Categoria bloqueada" },
  { value: "priority_franchise_exception", label: "Exceção por franquia prioritária" },
  { value: "pending_review", label: "Pendente de revisão" },
  { value: "manual_dashboard", label: "Decisão manual" },
  { value: "manual_dashboard_bulk", label: "Decisão manual em massa" },
  { value: "structured_no_brand_no_stock", label: "(legado) Sem marca e sem stock" },
  { value: "structured_min_price", label: "(legado) Abaixo do preço mínimo" },
  { value: "structured_junk_category", label: "(legado) Categoria excluída" },
];

export const REASON_LABEL_BY_CODE = Object.fromEntries(
  REASON_OPTIONS.filter((o) => o.value).map((o) => [o.value, o.label])
);

/** Motivos como "blocked_brand:FOO" trazem sufixo parametrizado depois de ":". */
export function reasonLabel(reason) {
  if (!reason) return "";
  const base = String(reason).split(":")[0];
  return REASON_LABEL_BY_CODE[base] || reason;
}
