// B14 (briefing backend, 24/09/2026), secção 8 — auditoria de imagens.
//
// SÓ LEITURA. Nada é sobrescrito, nada é carregado. Ponto 1 do passo (grep no repo por
// escrita em collection.image e pelo padrão -cover.png) já correu à parte: zero
// resultados — a app nunca escreveu collection.image nem qualquer variante de nome de
// ficheiro "-cover". Confirmado com:
//   grep -rn "collection\.image\|CollectionInput" lib scripts app
//   grep -rn "cover.png\|-cover" lib scripts app docs
// (ver relatório do commit). Se um dia isto voltar a dar zero e uma imagem estiver
// errada, foi carregada à mão no Admin — correção é do Carlos, não da app.
//
// Este script lista, por handle, collection.image (URL, largura, altura, alt) e
// alterpop.hero_image (idem, via MediaImage), marca tiles não quadradas (regressão
// Star Wars, 18/09/2026 — logo esticado por causa da imagem errada em collection.image)
// e gera uma página HTML com as miniaturas ao lado do handle, para revisão a olho.
//
// Âmbito: coleções com templateSuffix em (universe-room, line) — as mesmas que
// alterpop.hero_image foi pensado para servir (Universe Room).
//
// Uso: node scripts/maintenance/collection-image-audit.js
import fs from "fs/promises";
import path from "path";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";
import { getDefaultConfig } from "../../lib/importer/config.js";
import { UNIVERSE_TEMPLATE_SUFFIX } from "../../lib/importer/catalog/franchiseUniverses.js";
import { LINE_TEMPLATE_SUFFIX } from "../../lib/importer/catalog/franchiseLines.js";
import { reportBatchDone } from "../../lib/maintenance/batchReport.js";
import { auditCollectionImages } from "../../lib/importer/shopify/collectionImageAudit.js";

const SHOP = process.env.SHOPIFY_SHOP_URL;
const IN_SCOPE_TEMPLATE_SUFFIXES = new Set([UNIVERSE_TEMPLATE_SUFFIX, LINE_TEMPLATE_SUFFIX]);

const COLLECTIONS_PAGE = `
  query ImgAuditPage($cursor: String) {
    collections(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        title
        templateSuffix
        image { url altText width height }
        heroImage: metafield(namespace: "alterpop", key: "hero_image") {
          reference {
            ... on MediaImage {
              image { url altText width height }
            }
          }
        }
      }
    }
  }
`;

async function fetchInScopeCollections(client) {
  const out = [];
  let cursor = null;
  for (;;) {
    const data = await client.graphql(COLLECTIONS_PAGE, { cursor });
    const page = data.collections;
    for (const node of page.nodes) {
      if (IN_SCOPE_TEMPLATE_SUFFIXES.has(node.templateSuffix)) out.push(node);
    }
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return out;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function buildReportHtml(rows) {
  const trs = rows
    .map((r) => {
      const imgCell = r.image
        ? `<img src="${escapeHtml(r.image.url)}" width="80" alt="${escapeHtml(r.image.altText || "")}"><br>${r.image.width}×${r.image.height}<br>alt: "${escapeHtml(r.image.altText || "—")}"`
        : "—";
      const heroCell = r.heroImage
        ? `<img src="${escapeHtml(r.heroImage.url)}" width="120" alt="${escapeHtml(r.heroImage.altText || "")}"><br>${r.heroImage.width}×${r.heroImage.height}<br>alt: "${escapeHtml(r.heroImage.altText || "—")}"`
        : "—";
      const rowStyle = r.nonSquare ? ' style="background:#ffe0e0"' : "";
      const flag = r.nonSquare ? " ⚠ NÃO QUADRADA" : "";
      return `<tr${rowStyle}><td>${escapeHtml(r.handle)}${flag}<br><small>${escapeHtml(r.title)}</small></td><td>${imgCell}</td><td>${heroCell}</td></tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8">
<title>Auditoria de imagens — coleções Universe/Line</title>
<style>
  body { font-family: sans-serif; margin: 2rem; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #ccc; padding: 8px; vertical-align: top; text-align: left; }
  th { background: #f0f0f0; }
</style>
</head>
<body>
<h1>Auditoria de imagens — coleções Universe/Line</h1>
<p>Gerado em ${new Date().toISOString()}. Linhas a vermelho: collection.image não é quadrada.</p>
<table>
<thead><tr><th>Handle</th><th>collection.image</th><th>alterpop.hero_image</th></tr></thead>
<tbody>
${trs}
</tbody>
</table>
</body>
</html>
`;
}

async function main() {
  if (!SHOP) throw new Error("SHOPIFY_SHOP_URL not set");
  const session = await loadOfflineSessionForShop(SHOP);
  const client = createShopifyClientFromSession(session);

  const collections = await fetchInScopeCollections(client);
  const rows = collections.map(auditCollectionImages);

  console.log(`[collection-image-audit] ${rows.length} coleção(ões) em âmbito (templateSuffix universe-room/line)`);
  for (const r of rows) {
    const imgDesc = r.image ? `${r.image.width}×${r.image.height} alt="${r.image.altText || ""}"` : "sem collection.image";
    const heroDesc = r.heroImage ? `${r.heroImage.width}×${r.heroImage.height} alt="${r.heroImage.altText || ""}"` : "sem alterpop.hero_image";
    console.log(`[collection-image-audit]   ${r.handle}${r.nonSquare ? " [NÃO QUADRADA]" : ""} — image: ${imgDesc} — hero: ${heroDesc}`);
  }

  const nonSquareCount = rows.filter((r) => r.nonSquare).length;
  console.log(`[collection-image-audit] tiles não quadradas: ${nonSquareCount}`);

  const reportPath = path.join(getDefaultConfig().paths.data, "collection-image-audit.html");
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, buildReportHtml(rows), "utf8");
  console.log(`[collection-image-audit] página para revisão a olho: ${reportPath}`);

  reportBatchDone({
    tag: "collection-image-audit",
    itemsRead: rows.length,
    processed: rows.length,
    total: rows.length,
    extra: `non_square=${nonSquareCount}`,
  });
}

main().catch((err) => {
  console.error("[collection-image-audit] fatal:", err);
  process.exit(1);
});
