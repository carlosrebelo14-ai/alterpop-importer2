/**
 * Barra de acções — HTML nativo com estilos de fallback (funciona mesmo sem CSS Polaris).
 */
export function DashboardPageToolbar({
  onRefreshCatalog,
  refreshStarting,
  indexingActive,
  onSyncApproved,
  syncBusy,
  approvedCount,
  onPublishShopify,
  shopifyPublishBusy,
}) {
  return (
    <div className="alterpop-toolbar" role="toolbar" aria-label="Acções do painel">
      <button
        type="button"
        className="alterpop-btn"
        onClick={onRefreshCatalog}
        disabled={refreshStarting}
      >
        {indexingActive || refreshStarting ? "A indexar…" : "Actualizar catálogo"}
      </button>
      <button
        type="button"
        className="alterpop-btn"
        onClick={onSyncApproved}
        disabled={approvedCount === 0 || syncBusy}
      >
        {syncBusy ? "A sincronizar…" : "Pré-visualizar import CSV"}
      </button>
      <button
        type="button"
        className="alterpop-btn alterpop-btn--primary"
        onClick={onPublishShopify}
        disabled={approvedCount === 0 || shopifyPublishBusy}
      >
        {shopifyPublishBusy ? "A publicar na Shopify…" : "Publicar Aprovados na Shopify"}
      </button>
    </div>
  );
}
