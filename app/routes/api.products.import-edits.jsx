import { authenticateAdmin } from "../utils/authenticate.server";
import { parseCsv } from "../../lib/importer/catalog/csvExport.server.js";
import { prisma, safePrisma } from "../../lib/prisma/prismaSafe.server.js";
import {
  approveProduct,
  rejectProduct,
  setManualOverride,
  getCurationQueueEntry,
} from "../../lib/curation/curationQueue.server.js";
import { loadShopSettings } from "../../lib/importer/settings.server.js";
import { resolveMarginPct, tryPriceProduct } from "../../lib/importer/pricing/pricing.server.js";

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
    precoRegra: header.indexOf("preco_regra"),
    estado: header.indexOf("estado"),
  };

  // Revisão do PR #87 — CSVs exportados antes da regra de preço não têm preco_regra e
  // trazem em `preco` o netPrice × 1,4 calculado, não um override. Aplicá-lo congelava
  // esse valor (acima do PVPR) como override em todas as linhas. A coluna é ignorada e
  // o resultado diz porquê; o resto das edições aplica-se normalmente.
  const warnings = [];
  if (idx.preco !== -1 && idx.precoRegra === -1) {
    warnings.push({
      line: 1,
      sku: "",
      reason: "CSV num formato antigo (sem preco_regra): a coluna preco foi ignorada — traz o preço calculado antigo, não um override. Exporta de novo para fixar preços.",
    });
    idx.preco = -1;
  }

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
            select: { sku: true, distributorPrice: true, grossPrice: true },
          }),
        { fallback: [] }
      )
    )
  );
  const existingRows = existingRowChunks.flat();
  const existingSkuSet = new Set(existingRows.map((r) => r.sku));

  // Preço da regra ATUAL por SKU, para apanhar um número mudado dentro de "(regra)".
  // Pode diferir também porque a regra mudou desde a exportação — o aviso diz as duas.
  let ruleBySku = null;
  if (idx.precoRegra !== -1) {
    try {
      const marginPct = resolveMarginPct(await loadShopSettings(session.shop));
      ruleBySku = new Map(existingRows.map((r) => [r.sku, tryPriceProduct(r.distributorPrice, r.grossPrice, marginPct).finalPrice]));
    } catch (err) {
      warnings.push({ line: 1, sku: "", reason: `Não deu para comparar preco_regra com a regra atual: ${err?.message || err}` });
    }
  }

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

    // preco_regra é só leitura e sai como "17.50 (regra)" ou "(sem preço: …)". Uma
    // célula que já não tem essa forma foi editada: avisa por linha, em vez de a deixar
    // desaparecer em silêncio — sem recalcular a regra, que pode ter mudado desde a
    // exportação (revisão do PR #87).
    if (idx.precoRegra !== -1) {
      const ruleCell = (row[idx.precoRegra] || "").trim();
      const suffixed = /^([\d.,]+)\s*\(regra\)$/.exec(ruleCell);
      if (ruleCell && !suffixed && !ruleCell.startsWith("(sem preço")) {
        warnings.push({
          line: lineNo,
          sku,
          reason: `preco_regra editado ("${ruleCell}") — coluna só de leitura, ignorado. Para fixar o preço preenche a coluna preco.`,
        });
      } else if (suffixed && ruleBySku) {
        const n = parseFloat(suffixed[1].replace(",", "."));
        const rule = ruleBySku.get(sku);
        if (Number.isFinite(n) && rule != null && Math.round(n * 100) !== Math.round(rule * 100)) {
          warnings.push({
            line: lineNo,
            sku,
            reason: `preco_regra diz ${suffixed[1]} e a regra atual dá ${rule.toFixed(2)} (editado, ou a margem/custo mudou desde a exportação) — coluna só de leitura, ignorado. Para fixar o preço preenche a coluna preco.`,
          });
        }
      }
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
      // Ao cêntimo, como a Shopify o grava — 10.235 de uma fórmula ficava 10.23 na loja
      // e 10.235 na fila, e o aviso de "não aplicado" nunca batia certo.
      preco = Math.round(n * 100) / 100;
    }

    if (estadoRaw && !VALID_STATUSES.has(estadoRaw) && estadoRaw !== "PENDING" && estadoRaw !== "NO_DECISION") {
      rejected.push({ line: lineNo, sku, reason: `Estado desconhecido: "${estadoRaw}" (usa APPROVED, REJECTED ou deixa em branco)` });
      continue;
    }

    try {
      // Produto já publicado: o override de preço só se aplica na criação (o publisher
      // nunca reescreve o preço de um produto existente, salvo a 0,00 — revisão do PR
      // #87). Um preço novo aqui não teria efeito: avisa e não o grava. O mesmo valor do
      // override existente (vem pré-preenchido na exportação) não é edição — segue.
      if (preco != null) {
        const entry = await getCurationQueueEntry(sku);
        // Publicado = a fila sabe que existe na Shopify. Se não souber (produto criado pela
        // página Import, primeira publicação falhada a meio), o publisher deteta-o e regista
        // o aviso no registo de sync — nunca se perde em silêncio.
        const published = entry?.status === "PUBLISHED" || Boolean(entry?.metadata?.shopifyProductId);
        const current = entry?.metadata?.overrides?.price;
        const unchanged = current != null && Number(current).toFixed(2) === preco.toFixed(2);
        if (published && !unchanged) {
          warnings.push({
            line: lineNo,
            sku,
            kind: "price_not_applied",
            reason: `preço ${preco.toFixed(2)} não aplicado — produto já publicado; muda o preço no admin da Shopify.`,
          });
          preco = undefined;
        }
      }

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
    warningCount: warnings.length,
    applied,
    rejected,
    // Preços não aplicados primeiro — são os que o operador tem de ver no aviso curto.
    warnings: [...warnings].sort((a, b) => (b.kind === "price_not_applied") - (a.kind === "price_not_applied")),
  });
};
