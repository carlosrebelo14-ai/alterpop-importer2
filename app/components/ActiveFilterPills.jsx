/**
 * Pílulas removíveis para filtros activos (EN).
 * @param {{
 *   pills: { id: string, label: string, onRemove: () => void }[],
 *   onClearAll?: () => void,
 * }} props
 */
export function ActiveFilterPills({ pills = [], onClearAll }) {
  if (!pills.length) return null;

  return (
    <div className="active-filter-pills" role="list" aria-label="Active filters">
      {pills.map((pill) => (
        <span key={pill.id} className="active-filter-pill" role="listitem">
          <span>{pill.label}</span>
          <button
            type="button"
            aria-label={`Remove filter ${pill.label}`}
            onClick={pill.onRemove}
          >
            ×
          </button>
        </span>
      ))}
      {onClearAll && pills.length > 1 && (
        <button type="button" className="faceted-search__clear" onClick={onClearAll}>
          Clear all
        </button>
      )}
    </div>
  );
}
