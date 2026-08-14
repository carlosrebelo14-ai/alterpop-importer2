import '@shopify/ui-extensions/preact';
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

const APP_BASE_URL = "https://alterpop-importer-app.fly.dev";

export default async () => {
  render(<Extension />, document.body);
};

async function callWishlistApi(path, options = {}) {
  const token = await shopify.sessionToken.get();
  const response = await fetch(`${APP_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) throw new Error(`wishlist api ${path} -> HTTP ${response.status}`);
  return response.json();
}

function money(amount, currencyCode) {
  try {
    return new Intl.NumberFormat("pt-PT", { style: "currency", currency: currencyCode }).format(Number(amount));
  } catch {
    return `${amount} ${currencyCode}`;
  }
}

function Extension() {
  const [wishlist, setWishlist] = useState({ status: "loading", products: [] });
  const [suggestions, setSuggestions] = useState({ status: "loading", products: [] });
  const [pending, setPending] = useState(null);

  const loadWishlist = () =>
    callWishlistApi("/wishlist")
      .then((data) => setWishlist({ status: "ready", products: data.products || [] }))
      .catch(() => setWishlist({ status: "error", products: [] }));

  useEffect(() => {
    loadWishlist();

    shopify
      .query(
        `query ($first: Int!) {
          products(first: $first, sortKey: CREATED_AT, reverse: true) {
            nodes { id title featuredImage { url } priceRange { minVariantPrice { amount currencyCode } } }
          }
        }`,
        { variables: { first: 12 } }
      )
      .then(({ data }) => setSuggestions({ status: "ready", products: data?.products?.nodes || [] }))
      .catch(() => setSuggestions({ status: "error", products: [] }));
  }, []);

  const toggleWishlist = (productId, action) => {
    setPending(productId);
    callWishlistApi("/wishlist", { method: "POST", body: JSON.stringify({ action, productId }) })
      .then((data) => setWishlist({ status: "ready", products: data.products || [] }))
      .catch(() => {})
      .finally(() => setPending(null));
  };

  const savedIds = new Set(wishlist.products.map((p) => p.id));

  return (
    <s-page heading={shopify.i18n.translate("pageHeading")}>
      <s-section heading={shopify.i18n.translate("savedHeading")}>
        {wishlist.status === "loading" && <s-text>{shopify.i18n.translate("loading")}</s-text>}
        {wishlist.status === "error" && <s-text>{shopify.i18n.translate("loadError")}</s-text>}
        {wishlist.status === "ready" && wishlist.products.length === 0 && (
          <s-text>{shopify.i18n.translate("empty")}</s-text>
        )}
        {wishlist.status === "ready" && wishlist.products.length > 0 && (
          <s-grid gridTemplateColumns="repeat(auto-fill, minmax(140px, 1fr))" gap="base">
            {wishlist.products.map((product) => (
              <s-stack key={product.id} direction="block" gap="tight">
                {product.featuredImage?.url && (
                  <s-image src={product.featuredImage.url} alt={product.title} aspectRatio="1" />
                )}
                <s-text>{product.title}</s-text>
                {product.priceRangeV2?.minVariantPrice && (
                  <s-text tone="neutral">
                    {money(
                      product.priceRangeV2.minVariantPrice.amount,
                      product.priceRangeV2.minVariantPrice.currencyCode
                    )}
                  </s-text>
                )}
                <s-button
                  disabled={pending === product.id}
                  onClick={() => toggleWishlist(product.id, "remove")}
                >
                  {shopify.i18n.translate("remove")}
                </s-button>
              </s-stack>
            ))}
          </s-grid>
        )}
      </s-section>

      <s-section heading={shopify.i18n.translate("suggestionsHeading")}>
        {suggestions.status === "ready" && (
          <s-grid gridTemplateColumns="repeat(auto-fill, minmax(140px, 1fr))" gap="base">
            {suggestions.products
              .filter((product) => !savedIds.has(product.id))
              .map((product) => (
                <s-stack key={product.id} direction="block" gap="tight">
                  {product.featuredImage?.url && (
                    <s-image src={product.featuredImage.url} alt={product.title} aspectRatio="1" />
                  )}
                  <s-text>{product.title}</s-text>
                  {product.priceRange?.minVariantPrice && (
                    <s-text tone="neutral">
                      {money(product.priceRange.minVariantPrice.amount, product.priceRange.minVariantPrice.currencyCode)}
                    </s-text>
                  )}
                  <s-button
                    disabled={pending === product.id}
                    onClick={() => toggleWishlist(product.id, "add")}
                  >
                    {shopify.i18n.translate("add")}
                  </s-button>
                </s-stack>
              ))}
          </s-grid>
        )}
      </s-section>
    </s-page>
  );
}
