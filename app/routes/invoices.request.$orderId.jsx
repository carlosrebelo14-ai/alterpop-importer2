/* eslint-env node */
import { authenticate } from "../shopify.server";
import { prisma, safePrisma } from "../../lib/prisma/prismaSafe.server.js";
import { loadOfflineSessionForShop } from "../../lib/session/loadOfflineSessionForShop.server.js";
import { createShopifyClientFromSession } from "../../lib/importer/shopifyClient.js";

// Curto de propósito — depois de emitido, o token de download nunca mais toca a Admin
// API (ver InvoiceDownloadToken.orderSnapshotJson), por isso não precisa de margem para
// re-tentativas de rede; só cobre o tempo entre o cliente clicar e o link abrir.
const REQUEST_TOKEN_TTL_MS = 5 * 60 * 1000;

// Fetch único: confirma o dono da encomenda E traz tudo o que a fatura precisa, na
// mesma chamada — o token de download (rota pública) nunca volta a chamar a Admin API.
const ORDER_INVOICE_QUERY = `
  query OrderInvoice($id: ID!) {
    order(id: $id) {
      name
      createdAt
      email
      customer { id }
      shippingAddress { name address1 address2 city zip country provinceCode }
      billingAddress { name address1 address2 city zip country provinceCode }
      currentSubtotalPriceSet { shopMoney { amount currencyCode } }
      currentTotalDiscountsSet { shopMoney { amount currencyCode } }
      totalShippingPriceSet { shopMoney { amount currencyCode } }
      currentTotalTaxSet { shopMoney { amount currencyCode } }
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      lineItems(first: 250) {
        pageInfo { hasNextPage }
        nodes {
          name
          quantity
          originalTotalSet { shopMoney { amount currencyCode } }
        }
      }
    }
    shop {
      name
      contactEmail
      shopAddress { address1 address2 city zip country }
    }
  }
`;

function normalizeShopDomain(dest) {
  return String(dest || "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

/**
 * Emite um token de download de uma única utilização para a fatura de uma encomenda,
 * depois de confirmar (via session token do Customer Account UI Extension "order-invoice")
 * que quem pede é o dono da encomenda. Busca e guarda o snapshot completo da encomenda
 * já aqui — ver /invoices/download/$token, que só lê este snapshot, nunca a Admin API.
 */
export const action = async ({ request, params }) => {
  const { sessionToken, cors } = await authenticate.public.customerAccount(request);

  const shop = normalizeShopDomain(sessionToken.dest);
  const customerId = sessionToken.sub;

  if (!shop || !customerId) {
    return cors(Response.json({ error: "invalid_session" }, { status: 401 }));
  }

  const orderId = params.orderId;
  if (!/^\d+$/.test(String(orderId || ""))) {
    return cors(Response.json({ error: "invalid_order" }, { status: 400 }));
  }
  const orderGid = `gid://shopify/Order/${orderId}`;

  let offline;
  try {
    offline = await loadOfflineSessionForShop(shop);
  } catch (err) {
    console.error(`[invoices.request] sem sessão offline para ${shop}: ${err.message}`);
    return cors(Response.json({ error: "shop_not_connected" }, { status: 503 }));
  }

  const client = createShopifyClientFromSession(offline);
  const data = await client.graphql(ORDER_INVOICE_QUERY, { id: orderGid });
  const order = data?.order;

  if (!order || order.customer?.id !== customerId) {
    // Não distinguir "encomenda não existe" de "não é tua" na resposta — evita
    // usar isto para confirmar a existência de encomendas de outros clientes.
    return cors(Response.json({ error: "not_found" }, { status: 404 }));
  }

  if (order.lineItems?.pageInfo?.hasNextPage) {
    // Acontece muito raramente (encomendas grandes, ex. grossista) — preferível
    // recusar de forma explícita a mostrar uma fatura com itens em falta.
    console.warn(`[invoices.request] encomenda ${orderId} tem mais de 250 itens; fatura recusada`);
    return cors(Response.json({ error: "order_too_large" }, { status: 422 }));
  }

  // order.customer não faz parte do que a fatura mostra — não persistir.
  // eslint-disable-next-line no-unused-vars
  const { customer: _customer, ...invoiceOrder } = order;

  const token = await safePrisma("invoiceDownloadToken.create", () =>
    prisma.invoiceDownloadToken.create({
      data: {
        shop,
        orderId,
        customerId,
        orderSnapshotJson: JSON.stringify({ order: invoiceOrder, shop: data.shop }),
        expiresAt: new Date(Date.now() + REQUEST_TOKEN_TTL_MS),
      },
    })
  );

  if (!token) {
    return cors(Response.json({ error: "server_error" }, { status: 500 }));
  }

  const appUrl = process.env.APP_URL || process.env.SHOPIFY_APP_URL || "";
  return cors(Response.json({ url: `${appUrl}/invoices/download/${token.token}` }));
};
