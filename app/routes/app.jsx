/* global globalThis */
import { Outlet, useFetchers, useLoaderData, useNavigation, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { AppProvider as PolarisAppProvider, Banner, InlineStack, Spinner, Text } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import { authenticateAdmin } from "../utils/authenticate.server";
import { readDbDegraded } from "../../lib/health/dbDegraded.js";

export const loader = async ({ request }) => {
  await authenticateAdmin(request);
  return {
    apiKey: globalThis.process?.env?.SHOPIFY_API_KEY || "",
    dbDegraded: readDbDegraded(),
  };
};

export default function App() {
  const { apiKey, dbDegraded } = useLoaderData();
  const navigation = useNavigation();
  const fetchers = useFetchers();
  const isBusy =
    navigation.state !== "idle" ||
    fetchers.some((f) => f.state === "loading" || f.state === "submitting");

  return (
    <AppProvider embedded apiKey={apiKey}>
      <PolarisAppProvider i18n={enTranslations}>
        <s-app-nav>
          <s-link href="/app">Curadoria</s-link>
          <s-link href="/app/reports">Relatórios</s-link>
          <s-link href="/app/settings">Definições</s-link>
          <s-link href="/app/setup-guide">Setup Guide</s-link>
        </s-app-nav>
        {dbDegraded && (
          <div style={{ padding: "12px 12px 0" }}>
            <Banner tone="critical" title="Base de dados em modo degradado">
              <p>
                {dbDegraded.cause}
                {dbDegraded.at ? ` (desde ${dbDegraded.at})` : ""}. Publicação, sync de stock, escrita na fila e escrita na BD estão bloqueados. Não apagar nem reiniciar sem o restauro aprovado (Decisão 34).
              </p>
            </Banner>
          </div>
        )}
        {isBusy && (
          <div
            style={{
              borderBottom: "1px solid #e1e3e5",
              background: "#f6f6f7",
              padding: "6px 12px",
            }}
          >
            <InlineStack gap="200" blockAlign="center">
              <Spinner size="small" />
              <Text as="span" tone="subdued">
                A comunicar com o servidor…
              </Text>
            </InlineStack>
          </div>
        )}
        <Outlet />
      </PolarisAppProvider>
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
