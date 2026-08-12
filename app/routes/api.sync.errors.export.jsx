import { authenticateAdmin } from "../utils/authenticate.server";
import { listSyncErrors } from "../../lib/importer/sync/syncErrorLog.server.js";
import { buildCsv } from "../../lib/importer/catalog/csvExport.server.js";
import { prisma, safePrisma } from "../../lib/prisma/prismaSafe.server.js";

const HEADERS = ["sku", "titulo", "motivo", "timestamp"];

/**
 * GET /api/sync/errors/export?limit=500 — CSV dos erros de sincronização activos
 * (mesmo mecanismo de escrita CSV do item 9). Reaproveita listSyncErrors(), só
 * junta o título via CatalogProduct porque SyncErrorLog não o guarda.
 */
export const loader = async ({ request }) => {
  const { session } = await authenticateAdmin(request);
  const url = new URL(request.url);
  const limit = Math.min(2000, parseInt(url.searchParams.get("limit") || "500", 10) || 500);

  const errors = (await listSyncErrors(session.shop, limit)).filter((e) => e.active);

  const skus = errors.map((e) => e.sku).filter(Boolean);
  const products = await safePrisma("errorsExport.titles", () =>
    prisma.catalogProduct.findMany({
      where: { shop: session.shop, sku: { in: skus } },
      select: { sku: true, title: true },
    }),
    { fallback: [] }
  );
  const titleBySku = new Map(products.map((p) => [p.sku, p.title]));

  const rows = errors.map((e) => [
    e.sku,
    titleBySku.get(e.sku) || "",
    e.label || e.message,
    e.createdAt,
  ]);

  const csv = buildCsv(HEADERS, rows);
  const filename = `alterpop-erros-sync-${new Date().toISOString().slice(0, 10)}.csv`;

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
};
