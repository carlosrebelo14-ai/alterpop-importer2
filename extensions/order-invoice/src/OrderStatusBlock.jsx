import '@shopify/ui-extensions/preact';
import {render} from "preact";
import {useEffect, useState} from "preact/hooks";

const APP_BASE_URL = "https://alterpop-importer-app.fly.dev";

export default async () => {
  render(<Extension />, document.body)
}

async function callApi(path) {
  const token = await shopify.sessionToken.get();
  const response = await fetch(`${APP_BASE_URL}${path}`, {
    headers: {Authorization: `Bearer ${token}`},
  });
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
  return response.json();
}

// 3 fases, na linguagem da marca — ver dc-design "Alterpop Customer Account.dc.html"
// (secção Order tracking). Mapeamento real de FulfillmentDisplayStatus feito no backend
// (app/routes/orders.$orderId.tracking.jsx); aqui só desenhamos as 3 fases fixas.
const STAGES = [
  {key: "preparing", labelKey: "stagePreparing"},
  {key: "in_transit", labelKey: "stageInTransit"},
  {key: "delivered", labelKey: "stageDelivered"},
];
const STAGE_INDEX = {preparing: 0, in_transit: 1, delivered: 2, attention: 0};

// eslint-disable-next-line react/prop-types -- no prop-types package in this extension bundle
function TrackingSection({orderId}) {
  const [state, setState] = useState({status: "loading", data: null});

  useEffect(() => {
    let cancelled = false;
    callApi(`/orders/${orderId}/tracking`)
      .then((data) => {
        if (!cancelled) setState({status: "ready", data});
      })
      .catch(() => {
        if (!cancelled) setState({status: "error", data: null});
      });
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  if (state.status === "loading") {
    return (
      <s-section heading={shopify.i18n.translate("trackingHeading")}>
        <s-text>{shopify.i18n.translate("loadingTracking")}</s-text>
      </s-section>
    );
  }
  if (state.status === "error") {
    return (
      <s-section heading={shopify.i18n.translate("trackingHeading")}>
        <s-text>{shopify.i18n.translate("trackingError")}</s-text>
      </s-section>
    );
  }

  const {stage, tracking, estimatedDeliveryAt, items} = state.data;
  const currentIndex = STAGE_INDEX[stage] ?? 0;
  const bannerTone = stage === "attention" ? "critical" : stage === "delivered" ? "success" : "info";

  return (
    <s-section heading={shopify.i18n.translate("trackingHeading")}>
      <s-banner tone={bannerTone} heading={shopify.i18n.translate(`stageBanner_${stage}`)} />

      <s-stack direction="inline" gap="loose">
        {STAGES.map((s, i) => (
          <s-badge key={s.key} tone={i === currentIndex ? "auto" : "neutral"}>
            {(i < currentIndex ? "✓ " : "") + shopify.i18n.translate(s.labelKey)}
          </s-badge>
        ))}
      </s-stack>

      {tracking && (
        <s-banner heading={shopify.i18n.translate("trackingNumberLabel")}>
          <s-stack direction="block" gap="tight">
            <s-text>
              {tracking.number}
              {tracking.company ? ` · ${tracking.company}` : ""}
            </s-text>
            {tracking.url && (
              <s-link href={tracking.url} target="_blank">
                {shopify.i18n.translate("trackShipment")}
              </s-link>
            )}
          </s-stack>
        </s-banner>
      )}

      {estimatedDeliveryAt && (
        <s-text>
          {shopify.i18n.translate("estimatedDeliveryLabel")}:{" "}
          {new Date(estimatedDeliveryAt).toLocaleDateString("pt-PT")}
        </s-text>
      )}

      <s-stack direction="block" gap="tight">
        {items.map((item, i) => (
          <s-text key={i}>
            {item.name} × {item.quantity}
          </s-text>
        ))}
      </s-stack>
    </s-section>
  );
}

// eslint-disable-next-line react/prop-types -- no prop-types package in this extension bundle
function InvoiceSection({orderId}) {
  const [state, setState] = useState({status: "loading", url: null});

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const token = await shopify.sessionToken.get();
        const response = await fetch(`${APP_BASE_URL}/invoices/request/${orderId}`, {
          method: "POST",
          headers: {Authorization: `Bearer ${token}`},
        });

        if (!response.ok) {
          if (cancelled) return;
          setState({status: response.status === 404 ? "unavailable" : "error", url: null});
          return;
        }

        const data = await response.json();
        if (cancelled) return;
        setState({status: "ready", url: data.url});
      } catch {
        if (!cancelled) setState({status: "error", url: null});
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [orderId]);

  return (
    <s-section heading={shopify.i18n.translate("invoiceHeading")}>
      {state.status === "loading" && (
        <s-text>{shopify.i18n.translate("loadingInvoice")}</s-text>
      )}
      {state.status === "ready" && (
        <s-link href={state.url} target="_blank">
          {shopify.i18n.translate("downloadInvoice")}
        </s-link>
      )}
      {state.status === "unavailable" && (
        <s-text>{shopify.i18n.translate("invoiceUnavailable")}</s-text>
      )}
      {state.status === "error" && (
        <s-text>{shopify.i18n.translate("invoiceError")}</s-text>
      )}
      <s-link href="extension:wishlist/">{shopify.i18n.translate("viewWishlist")}</s-link>
    </s-section>
  );
}

function Extension() {
  const order = shopify.order.value;
  if (!order) return null;

  const orderId = order.id.split('/').pop();

  return (
    <>
      <TrackingSection orderId={orderId} />
      <InvoiceSection orderId={orderId} />
    </>
  );
}
