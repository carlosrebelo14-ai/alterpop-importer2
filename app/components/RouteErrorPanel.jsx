import { useLocation, useRouteError } from "react-router";
import { Banner, BlockStack, Text } from "@shopify/polaris";
import { describeRouteError } from "../utils/routeErrorInfo.js";

/** ErrorBoundary de rota (D1): mostra rota, estado e detalhe, nunca só o número de estado. */
export function RouteErrorPanel() {
  const error = useRouteError();
  const { pathname } = useLocation();
  const info = describeRouteError(error, pathname);
  return (
    <div style={{ padding: 16 }}>
      <Banner tone="critical" title={info.title}>
        <BlockStack gap="200">
          <Text as="p">{`Rota: ${info.route}`}</Text>
          {info.status != null && <Text as="p">{`Estado HTTP: ${info.status}`}</Text>}
          <Text as="p">{info.detail}</Text>
        </BlockStack>
      </Banner>
    </div>
  );
}
