import "dotenv/config";

function getRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Falta a variável obrigatória: ${name}`);
  }
  return value;
}

function main() {
  const shop = process.env.SHOPIFY_SHOP_URL?.trim() || "alterpop-2.myshopify.com";
  const apiKey = getRequiredEnv("SHOPIFY_API_KEY");
  getRequiredEnv("SHOPIFY_API_SECRET");

  const scopes = (
    process.env.SCOPES ||
      "read_products,write_products,read_inventory,write_inventory,read_locations,read_orders,read_publications,write_publications"
  )
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean)
    .join(",");

  const appBaseUrl =
    process.env.SHOPIFY_APP_URL || process.env.APP_URL || "http://localhost:3000";
  const usedFallbackUrl = !process.env.SHOPIFY_APP_URL && !process.env.APP_URL;

  const redirectUri = new URL("/auth/callback", appBaseUrl).toString();
  const installUrl = new URL(`https://${shop}/admin/oauth/authorize`);
  installUrl.searchParams.set("client_id", apiKey);
  installUrl.searchParams.set("scope", scopes);
  installUrl.searchParams.set("redirect_uri", redirectUri);

  console.log("URL de instalação OAuth:");
  console.log(installUrl.toString());
  if (usedFallbackUrl) {
    console.log(
      "Aviso: foi usado APP_URL fallback (http://localhost:3000). Define APP_URL real para OAuth sem ajustes."
    );
  }
  console.log("");
  console.log(`Comando para abrir no browser: open "${installUrl.toString()}"`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[oauth-url] ${message}`);
  process.exit(1);
}
