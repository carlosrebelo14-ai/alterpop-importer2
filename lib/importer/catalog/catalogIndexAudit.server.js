/**
 * Contabilidade de auditoria — indexação CSV (stream).
 */

/** @typedef {Record<string, number>} RejectionReasons */

/**
 * @returns {{
 *   totalLinesRead: number,
 *   totalImported: number,
 *   totalRejected: number,
 *   rejectionReasons: RejectionReasons,
 * }}
 */
export function createCatalogIndexAudit() {
  return {
    totalLinesRead: 0,
    totalImported: 0,
    totalRejected: 0,
    rejectionReasons: {
      missingData: 0,
      outOfStock: 0,
      badCategory: 0,
      lowPrice: 0,
      blockedBrand: 0,
      liquidation: 0,
      other: 0,
    },
  };
}

/**
 * Mapeia motivo técnico → chave de relatório.
 * @param {string} [reason]
 * @returns {keyof ReturnType<typeof createCatalogIndexAudit>['rejectionReasons']}
 */
export function classifyRejectionReason(reason) {
  const r = String(reason || "").toLowerCase();

  if (!r || r === "missing_sku") return "missingData";
  if (r.includes("no_stock") || r.includes("no_brand_no_stock")) return "outOfStock";
  if (
    r.includes("junk_category") ||
    r.includes("generic_textil") ||
    r.includes("stationery") ||
    r.includes("papeler") ||
    r.includes("escolar") ||
    r.includes("blocked_category")
  ) {
    return "badCategory";
  }
  if (r.includes("min_price") || r.includes("low_price") || r.includes("elite_min")) {
    return "lowPrice";
  }
  if (r.includes("blocked_brand")) return "blockedBrand";
  if (r.includes("liquidation") || r.includes("clearance")) return "liquidation";

  return "other";
}

/**
 * @param {ReturnType<typeof createCatalogIndexAudit>} audit
 * @param {string} [reason]
 */
export function recordCatalogRejection(audit, reason) {
  const key = classifyRejectionReason(reason);
  audit.rejectionReasons[key] = (audit.rejectionReasons[key] || 0) + 1;
  audit.totalRejected += 1;
}

/** Labels PT para UI */
export const REJECTION_REASON_LABELS = {
  missingData: "Dados em falta (SKU inválido)",
  outOfStock: "Sem stock / sem marca válida",
  badCategory: "Categoria bloqueada ou têxtil genérico",
  lowPrice: "Preço abaixo do mínimo",
  blockedBrand: "Marca bloqueada (mass-market)",
  liquidation: "Liquidação / clearance",
  other: "Outros motivos",
};

/**
 * @param {ReturnType<typeof createCatalogIndexAudit>} audit
 */
export function finalizeCatalogIndexAudit(audit) {
  const sumReasons = Object.values(audit.rejectionReasons).reduce((a, b) => a + b, 0);
  const computedRejected = Math.max(0, audit.totalLinesRead - audit.totalImported);
  audit.totalRejected = computedRejected;
  if (sumReasons < computedRejected) {
    audit.rejectionReasons.other += computedRejected - sumReasons;
  }
  return audit;
}

/**
 * @param {ReturnType<typeof createCatalogIndexAudit>} audit
 */
export function buildAuditSummary(audit) {
  const finalized = finalizeCatalogIndexAudit({ ...audit, rejectionReasons: { ...audit.rejectionReasons } });
  return {
    totalLinesRead: finalized.totalLinesRead,
    totalImported: finalized.totalImported,
    totalRejected: finalized.totalRejected,
    rejectionReasons: { ...finalized.rejectionReasons },
  };
}
