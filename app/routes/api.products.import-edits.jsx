import { authenticateAdmin } from "../utils/authenticate.server";
import { parseCsv } from "../../lib/importer/catalog/csvExport.server.js";
import { prisma, safePrisma } from "../../lib/prisma/prismaSafe.server.js";
import {
  approveProduct,
  rejectProduct,
  setManualOverride,
} from "../../lib/curation/curationQueue.server.js";

const VALID_STATUSES = new Set(["APPROVED", "REJECTED"]);

/**
 * POST /api/products/import-edits — multipart/form-data com campo "file" (CSV
 * exportado por /api/products/export e editado à mão). SKU/EAN/custo são
 * ignorados mesmo que tenham sido alterados — só título/categoria/preço/estado
 * são aplicados. Reporta por linha o que foi aplicado ou rejeitado, com motivo.
 */
export const action = async ({ request }) => {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "Method not allowed" }, { status: 405 });
  }

  const { session } = await authenticateAdmin(request);

  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") {
    return Response.json({ ok: false, error: "Ficheiro CSV em falta" }, { status: 400 });
  }

  const text = await file.text();
  const rows = parseCsv(text);
  if (!rows.length) {
    return Response.json({ ok: false, error: "CSV vazio" }, { status: 400 });
  }

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const dataRows = rows.slice(1);

  const idx = {
    sku: header.indexOf("sku"),
    titulo: header.indexOf("titulo"),
    categoria: header.indexOf("categoria"),
    preco: header.indexOf("preco"),
    estado: header.indexOf("estado"),
  };

  if (idx.sku === -1) {
    return Response.json({ ok: false, error: "Coluna 'sku' em falta no CSV" }, { status: 400 });
  }

  const skus = dataRows.map((r) => (r[idx.sku] || "").trim()).filter(Boolean);
  // Chunk de 500 — evita o limite de parâmetros do SQLite em CSVs grandes (ver
  // SKU_FILTER_CHUNK_SIZE em catalogProductsDb.server.js).
  const skuChunks = [];
  for (let i = 0; i < skus.length; i += 500) skuChunks.push(skus.slice(i, i + 500));
  const existingRowChunks = await Promise.all(
    skuChunks.map((chunk) =>
      safePrisma(
        "importEdits.validateSkus",
        () =>
          prisma.catalogProduct.findMany({
            where: { shop: session.shop, sku: { in: chunk } },
            select: { sku: true },
          }),
        { fallback: [] }
      )
    )
  );
  const existingSkuSet = new Set(existingRowChunks.flat().map((r) => r.sku));

  const applied = [];
  const rejected = [];

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const lineNo = i + 2; // +1 para 0-index, +1 para o header
    const sku = (row[idx.sku] || "").trim();

    if (!sku) {
      rejected.push({ line: lineNo, sku: "", reason: "SKU em falta" });
      continue;
    }
    if (!existingSkuSet.has(sku)) {
      rejected.push({ line: lineNo, sku, reason: "SKU não existe no catálogo indexado desta loja" });
      continue;
    }

    const titulo = idx.titulo !== -1 ? (row[idx.titulo] || "").trim() : "";
    const categoria = idx.categoria !== -1 ? (row[idx.categoria] || "").trim() : "";
    const precoRaw = idx.preco !== -1 ? (row[idx.preco] || "").trim() : "";
    const estadoRaw = idx.estado !== -1 ? (row[idx.estado] || "").trim().toUpperCase() : "";

    let preco;
    if (precoRaw) {
      const n = parseFloat(precoRaw.replace(",", "."));
      if (!Number.isFinite(n) || n <= 0) {
        rejected.push({ line: lineNo, sku, reason: `Preço inválido: "${precoRaw}"` });
        continue;
      }
      preco = n;
    }

    if (estadoRaw && !VALID_STATUSES.has(estadoRaw) && estadoRaw !== "PENDING" && estadoRaw !== "NO_DECISION") {
      rejected.push({ line: lineNo, sku, reason: `Estado desconhecido: "${estadoRaw}" (usa APPROVED, REJECTED ou deixa em branco)` });
      continue;
    }

    try {
      const overrides = {};
      if (titulo) overrides.title = titulo;
      if (categoria) overrides.category = categoria;
      if (preco != null) overrides.price = preco;
      if (Object.keys(overrides).length) {
        await setManualOverride(sku, overrides);
      }

      if (estadoRaw === "APPROVED") {
        await approveProduct(sku);
      } else if (estadoRaw === "REJECTED") {
        await rejectProduct(sku);
      }

      applied.push({ line: lineNo, sku });
    } catch (err) {
      rejected.push({ line: lineNo, sku, reason: err?.message || "Erro desconhecido ao aplicar" });
    }
  }

  return Response.json({
    ok: true,
    totalRows: dataRows.length,
    appliedCount: applied.length,
    rejectedCount: rejected.length,
    applied,
    rejected,
  });
};
