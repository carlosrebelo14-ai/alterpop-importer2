import '@shopify/ui-extensions/preact';
import {render} from "preact";
import {useEffect, useState} from "preact/hooks";

const APP_BASE_URL = "https://alterpop-importer-app.fly.dev";

export default async () => {
  render(<Extension />, document.body)
}

function Extension() {
  const [firstName, setFirstName] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await shopify.sessionToken.get();
        const response = await fetch(`${APP_BASE_URL}/customer/me`, {
          headers: {Authorization: `Bearer ${token}`},
        });
        if (!response.ok || cancelled) return;
        const data = await response.json();
        if (!cancelled) setFirstName(data.firstName);
      } catch {
        // Saudação genérica sem nome é um fallback aceitável — não vale a pena mostrar erro.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const greeting = firstName
    ? shopify.i18n.translate("welcomeBackNamed", {name: firstName})
    : shopify.i18n.translate("welcomeBack");

  return (
    <s-section>
      <s-heading>{greeting}</s-heading>

      <s-stack direction="inline" gap="base">
        <s-box border="base" borderRadius="base" padding="base">
          <s-link href="extension:wishlist/">{shopify.i18n.translate("wishlistQuickLink")}</s-link>
        </s-box>
        <s-box border="base" borderRadius="base" padding="base">
          <s-text tone="neutral">{shopify.i18n.translate("pointsComingSoon")}</s-text>
        </s-box>
      </s-stack>
    </s-section>
  );
}
