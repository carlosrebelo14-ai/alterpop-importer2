import { authenticateAdmin } from "../utils/authenticate.server";
import {
  bulkSetMarginMultiplier,
  bulkSetQueueStatus,
} from "../../lib/curation/curationQueue.server.js";
import { invalidateCurationQueueCache } from "../../lib/importer/curation/index.js";
import { computeCurationSkuFilter } from "../../lib/curation/curationStatusFilter.server.js";

/**
 * POST /api/curation/queue/bulk
 * body: { skus: string[], action: 'approve'|'reject'|'margin', marginMultiplier?: number }
 * ou body: { action: 'approve_filtered'|'reject_filtered', filters: {...} }
 */
export const action = async ({ request }) => {
  const { session } = await authenticateAdmin(request);

  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }

  const actionName = String(body.action || "");
  try {
    let skus = Array.isArray(body.skus) ? body.skus.map(String).filter(Boolean) : [];

    if (actionName === "approve_filtered" || actionName === "reject_filtered") {
      const { getMatchingCatalogSkus } = await import("../../lib/importer/catalog/catalogProductsDb.server.js");
      const filters = body.filters || {};

      // Tem de usar EXATAMENTE os mesmos filtros que /api/products usa para mostrar a
      // contagem no botão "Aprovar/Rejeitar Toda a Pesquisa" — searchScope/
      // curationStatus/reason faltavam aqui antes, fazendo o botão aprovar um conjunto
      // diferente (mais pequeno) do que estava a mostrar (bug reportado 2026-08-13:
      // "selecionei 135, só aprovou 100").
      const { skuInclude, skuExclude } = await computeCurationSkuFilter(
        filters.curationStatus || null,
        filters.reason || null
      );

      skus = await getMatchingCatalogSkus(session.shop, {
        brand: filters.brand || null,
        search: filters.search || "",
        searchScope: filters.searchScope || "all",
        minPrice: filters.minPrice || "",
        maxPrice: filters.maxPrice || "",
        inStockOnly: filters.inStockOnly,
        filterIds: Array.isArray(filters.filterIds) ? filters.filterIds : [],
        skuInclude,
        skuExclude,
      });
    }

    if (!skus.length) {
      return Response.json({ ok: false, error: "Nenhum produto encontrado para esta ação." }, { status: 400 });
    }

    if (actionName === "approve" || actionName === "reject" || actionName === "approve_filtered" || actionName === "reject_filtered") {
      const targetStatus = actionName.startsWith("approve") ? "APPROVED" : "REJECTED";
      const result = await bulkSetQueueStatus(skus, targetStatus);
      invalidateCurationQueueCache();
      return Response.json({
        ok: true,
        action: actionName,
        updated: result.updatedItems.length,
        previousSnapshots: result.previousSnapshots,
        // O frontend precisa disto para actualizar o estado local `decisions` depois de
        // approve_filtered/reject_filtered — sem a lista de SKUs de volta, o botão
        // "Publicar na Shopify" ficava cinzento até um reload completo da página (o
        // segundo bug do mesmo report: approve_filtered nunca actualizava `decisions`).
        skus,
      });
    }

    if (actionName === "margin") {
      const multiplier = Number(body.marginMultiplier);
      const result = await bulkSetMarginMultiplier(skus, multiplier);
      invalidateCurationQueueCache();
      return Response.json({
        ok: true,
        action: actionName,
        updated: result.updatedItems.length,
        marginMultiplier: result.marginMultiplier,
      });
    }

    return Response.json({ ok: false, error: "Ação inválida." }, { status: 400 });
  } catch (err) {
    return Response.json({ ok: false, error: err?.message || String(err) }, { status: 500 });
  }
};
