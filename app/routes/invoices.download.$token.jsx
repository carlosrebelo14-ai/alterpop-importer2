/* eslint-env node */
import { prisma, safePrisma } from "../../lib/prisma/prismaSafe.server.js";
import { escapeHtml } from "../../lib/importer/shopify/shopifyMapper.server.js";

function money(moneySet, currencyCode) {
  const amount = Number(moneySet?.shopMoney?.amount ?? 0);
  const currency = moneySet?.shopMoney?.currencyCode || currencyCode || "EUR";
  try {
    return new Intl.NumberFormat("pt-PT", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function formatAddress(address) {
  if (!address) return "";
  const lines = [
    address.name,
    address.address1,
    address.address2,
    [address.zip, address.city].filter(Boolean).join(" "),
    [address.provinceCode, address.country].filter(Boolean).join(", "),
  ].filter(Boolean);
  return lines.map(escapeHtml).join("<br>");
}

function renderInvoiceHtml({ order, shop }) {
  const currency = order.currentTotalPriceSet?.shopMoney?.currencyCode;
  const rows = order.lineItems.nodes
    .map(
      (li) => `
        <tr>
          <td>${escapeHtml(li.name)}</td>
          <td class="num">${li.quantity}</td>
          <td class="num">${money(li.originalTotalSet, currency)}</td>
        </tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="pt-PT">
<head>
<meta charset="utf-8">
<title>Fatura ${escapeHtml(order.name)} — ${escapeHtml(shop.name)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; max-width: 780px; margin: 0 auto; padding: 2.5rem 1.5rem; color: #1a1a1a; }
  header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 2.5rem; flex-wrap: wrap; gap: 1.5rem; }
  h1 { font-size: 1.6rem; margin: 0 0 .3rem; }
  .muted { color: #666; font-size: .9rem; }
  .addresses { display: flex; gap: 3rem; margin-bottom: 2rem; flex-wrap: wrap; }
  .addresses h2 { font-size: .85rem; text-transform: uppercase; letter-spacing: .04em; color: #666; margin: 0 0 .5rem; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; }
  th, td { text-align: left; padding: .6rem .4rem; border-bottom: 1px solid #e5e5e5; }
  th { font-size: .8rem; text-transform: uppercase; color: #666; }
  .num { text-align: right; }
  tfoot td { border-bottom: none; padding-top: .3rem; }
  tfoot tr:last-child td { font-weight: 700; font-size: 1.1rem; border-top: 2px solid #1a1a1a; padding-top: .8rem; }
  .print-btn { margin-top: 2rem; }
  .print-btn button { font: inherit; padding: .7rem 1.4rem; border-radius: 6px; border: none; background: #1a1a1a; color: #fff; cursor: pointer; }
  @media print { .print-btn { display: none; } body { padding: 0; } }
</style>
</head>
<body>
  <header>
    <div>
      <h1>${escapeHtml(shop.name)}</h1>
      <div class="muted">${formatAddress(shop.shopAddress)}</div>
      <div class="muted">${escapeHtml(shop.contactEmail)}</div>
    </div>
    <div>
      <h1>Fatura ${escapeHtml(order.name)}</h1>
      <div class="muted">${new Date(order.createdAt).toLocaleDateString("pt-PT")}</div>
    </div>
  </header>

  <div class="addresses">
    <div>
      <h2>Faturar a</h2>
      ${formatAddress(order.billingAddress) || escapeHtml(order.email)}
    </div>
    <div>
      <h2>Enviar para</h2>
      ${formatAddress(order.shippingAddress) || escapeHtml(order.email)}
    </div>
  </div>

  <table>
    <thead>
      <tr><th>Artigo</th><th class="num">Qtd.</th><th class="num">Total</th></tr>
    </thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr><td colspan="2">Subtotal</td><td class="num">${money(order.currentSubtotalPriceSet, currency)}</td></tr>
      <tr><td colspan="2">Desconto</td><td class="num">−${money(order.currentTotalDiscountsSet, currency)}</td></tr>
      <tr><td colspan="2">Envio</td><td class="num">${money(order.totalShippingPriceSet, currency)}</td></tr>
      <tr><td colspan="2">IVA</td><td class="num">${money(order.currentTotalTaxSet, currency)}</td></tr>
      <tr><td colspan="2">Total</td><td class="num">${money(order.currentTotalPriceSet, currency)}</td></tr>
    </tfoot>
  </table>

  <div class="print-btn">
    <button onclick="window.print()">Imprimir / Guardar como PDF</button>
  </div>
</body>
</html>`;
}

/**
 * Resolve um token de download de fatura de uma única utilização (emitido por
 * /invoices/request/$orderId) e devolve uma página HTML de fatura, imprimível
 * (botão "Guardar como PDF" usa window.print()). Público de propósito — o próprio
 * token é a credencial, não uma sessão Shopify.
 *
 * Nunca chama a Admin API: o snapshot da encomenda já foi buscado e guardado no
 * momento do pedido (ver invoices.request.$orderId.jsx), por isso não há nenhuma
 * chamada de rede que possa falhar DEPOIS de o token ser consumido.
 */
export const loader = async ({ params }) => {
  const rawToken = params.token;

  const record = await safePrisma("invoiceDownloadToken.find", () =>
    prisma.invoiceDownloadToken.findUnique({ where: { token: rawToken } })
  );

  if (!record) {
    return new Response("Link inválido ou expirado.", { status: 404 });
  }

  if (record.usedAt || record.expiresAt < new Date()) {
    return new Response("Este link já foi usado ou expirou. Volta à tua conta e tenta de novo.", {
      status: 410,
    });
  }

  // Reivindicação atómica: só uma requisição consegue passar esta condição, mesmo com
  // dois pedidos em simultâneo para o mesmo token (double-click, pré-fetch de link).
  const claim = await safePrisma("invoiceDownloadToken.claim", () =>
    prisma.invoiceDownloadToken.updateMany({
      where: { token: rawToken, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    })
  );

  if (!claim || claim.count !== 1) {
    return new Response("Este link já foi usado ou expirou. Volta à tua conta e tenta de novo.", {
      status: 410,
    });
  }

  let snapshot;
  try {
    snapshot = JSON.parse(record.orderSnapshotJson);
  } catch (err) {
    console.error(`[invoices.download] snapshot corrompido para token ${rawToken}: ${err.message}`);
    return new Response("Não foi possível gerar a fatura. Contacta o suporte da Alterpop.", { status: 500 });
  }

  const html = renderInvoiceHtml(snapshot);
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
};
