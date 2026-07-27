import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import dashboardEmbedStyles from "./styles/dashboard-embed.css?url";

export const links = () => [
  { rel: "preconnect", href: "https://cdn.shopify.com/" },
  {
    rel: "stylesheet",
    href: "https://cdn.shopify.com/static/fonts/inter/v4/styles.css",
  },
  { rel: "stylesheet", href: polarisStyles },
  { rel: "stylesheet", href: dashboardEmbedStyles },
];

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
