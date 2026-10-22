import { prisma, safePrisma } from "../../lib/prisma/prismaSafe.server.js";
import { servirImagemDoCatalogo, skuDoCaminho } from "../../lib/catalog/catalogImageProxy.server.js";

/**
 * GET /api/catalog-image/:sku/:i — miniatura do catálogo, servida pela app.
 *
 * Sem sessão de propósito: uma tag img não envia o token da sessão Shopify. Se a rota pedisse sessão,
 * a miniatura falhava sempre. A rota também não recebe nenhum URL do cliente. Lê o imageUrl do catálogo
 * pelo SKU e pelo índice.
 *
 * Só loader. Um POST recebe 405.
 */

/** Mesma regra de normalizeShopDomain em lib/session/loadOfflineSessionForShop.server.js, que não é exportada. */
function normalizarLoja(raw) {
  const valor = String(raw || "").trim();
  if (!valor) return "";
  return valor.replace(/^https?:\/\//i, "").replace(/\/$/, "").toLowerCase();
}

/**
 * Leitura da linha pelo safePrisma, como na rota irmã api.catalog.brands.jsx. Uma corrupção do SQLite fica
 * registada e ativa o modo degradado (Decisão 34). Com rethrow o erro sobe até à lib, que responde 404.
 */
const bdDoCatalogo = {
  catalogProduct: {
    findUnique: (args) => safePrisma("catalog-image", () => prisma.catalogProduct.findUnique(args), { rethrow: true }),
  },
};

export async function loader({ params, request }) {
  const shop = normalizarLoja(process.env.SHOPIFY_SHOP_URL || process.env.SHOPIFY_STORE || process.env.SHOPIFY_SHOP);
  if (!shop) {
    return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  // Índice só com dígitos. Qualquer outra coisa vira -1, e a lib recusa.
  const indice = /^\d+$/.test(params.i ?? "") ? Number(params.i) : -1;

  // SKU do segmento cru do URL, e não params.sku: o React Router descodifica o parâmetro outra vez.
  return servirImagemDoCatalogo({ prisma: bdDoCatalogo, shop, sku: skuDoCaminho(new URL(request.url).pathname), indice });
}
