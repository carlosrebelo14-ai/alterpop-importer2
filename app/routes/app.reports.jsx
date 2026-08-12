import { useCallback, useState } from "react";
import { useLoaderData } from "react-router";
import { Page, Layout, Card, Text, BlockStack, Banner, Button, ProgressBar } from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticateAdmin } from "../utils/authenticate.server";
import { getDashboardStats } from "../../lib/importer/dashboard/getDashboardStats.server.js";
import { formatEur } from "../../lib/importer/catalog/categoryLabel.js";
import { SyncErrorLogsPanel } from "../components/SyncErrorLogsPanel.jsx";
import { LastSyncRunBanner } from "../components/LastSyncRunBanner.jsx";

export const loader = async ({ request }) => {
  const { session } = await authenticateAdmin(request);
  const dashboardStats = await getDashboardStats(session.shop);
  return { shop: session.shop, dashboardStats };
};

export default function ReportsPage() {
  const { dashboardStats } = useLoaderData();
  const shopify = useAppBridge();
  const [salesRefreshing, setSalesRefreshing] = useState(false);
  const [lastSalesResult, setLastSalesResult] = useState(null);

  const refreshSales = useCallback(async () => {
    setSalesRefreshing(true);
    try {
      const res = await fetch("/api/shopify/sales-refresh", {
        method: "POST",
        credentials: "same-origin",
      });
      const data = await res.json();
      if (data?.ok) {
        const count = data.skusWithSales ?? 0;
        setLastSalesResult(count);
        shopify.toast.show(`Vendas actualizadas (${count} SKUs com vendas)`);
        return;
      }
      if (data?.needsScopeGrant && data.grantUrl) {
        const go = window.confirm(
          `${data.error || "Autorizar read_orders?"}\n\nSerás redireccionado para a Shopify.`
        );
        if (go) {
          window.open(data.grantUrl, "_top");
        }
        return;
      }
      shopify.toast.show(data?.error || "Erro ao actualizar vendas", { isError: true });
    } catch {
      shopify.toast.show("Falha de rede ao actualizar vendas", { isError: true });
    } finally {
      setSalesRefreshing(false);
    }
  }, [shopify]);

  const hasApproved = (dashboardStats.totalApproved || 0) > 0;

  return (
    <div className="alterpop-dashboard alterpop-page-shell">
      <Page fullWidth title="Relatórios">
        <BlockStack gap="400">
          {!hasApproved && (
            <Banner tone="info">
              Aprova pelo menos 1 produto na Curadoria para veres estas métricas com dados reais.
              Por agora mostram 0€/0% porque a fila de aprovados está vazia.
            </Banner>
          )}

          <div className="alterpop-kpi-grid">
            <Card className="alterpop-fade-in">
              <BlockStack gap="100">
                <Text as="p" tone="subdued" variant="bodySm">
                  Total Potential Revenue
                </Text>
                <Text
                  as="p"
                  variant="headingLg"
                  tone={(dashboardStats.totalPotentialRevenue || 0) === 0 ? "subdued" : undefined}
                >
                  {formatEur(dashboardStats.totalPotentialRevenue)}
                </Text>
              </BlockStack>
            </Card>

            <Card className="alterpop-fade-in">
              <BlockStack gap="100">
                <Text as="p" tone="subdued" variant="bodySm">
                  Estimated Net Profit
                </Text>
                <Text
                  as="p"
                  variant="headingLg"
                  tone={(dashboardStats.estimatedNetProfit || 0) === 0 ? "subdued" : undefined}
                >
                  {formatEur(dashboardStats.estimatedNetProfit)}
                </Text>
              </BlockStack>
            </Card>

            <Card className="alterpop-fade-in">
              <BlockStack gap="100">
                <Text as="p" tone="subdued" variant="bodySm">
                  Inventory Volume
                </Text>
                <Text
                  as="p"
                  variant="headingLg"
                  tone={(dashboardStats.inventoryVolume || 0) === 0 ? "subdued" : undefined}
                >
                  {(dashboardStats.inventoryVolume || 0).toLocaleString("pt-PT")}
                </Text>
              </BlockStack>
            </Card>

            <Card className="alterpop-fade-in">
              <BlockStack gap="100">
                <Text as="p" tone="subdued" variant="bodySm">
                  Shopify Sync Health
                </Text>
                <Text as="p" variant="headingLg">
                  {`${Math.round((dashboardStats.syncHealthRate || 0) * 100)}%`}
                </Text>
                <ProgressBar
                  progress={Math.round((dashboardStats.syncHealthRate || 0) * 100)}
                  tone={(dashboardStats.syncHealthRate || 0) >= 0.8 ? "success" : "warning"}
                />
                {(dashboardStats.totalPublished || 0) === 0 && (dashboardStats.totalSyncError || 0) === 0 && (
                  <Text as="p" tone="subdued" variant="bodySm">
                    Ainda sem publicações — 100% é o valor por defeito, não uma medição real.
                  </Text>
                )}
              </BlockStack>
            </Card>

            <Card className="alterpop-fade-in">
              <BlockStack gap="100">
                <Text as="p" tone="subdued" variant="bodySm">
                  Sem Decisão
                </Text>
                <Text
                  as="p"
                  variant="headingLg"
                  tone={(dashboardStats.withoutDecision || 0) > 0 ? "caution" : "subdued"}
                >
                  {(dashboardStats.withoutDecision || 0).toLocaleString("pt-PT")}
                </Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  {dashboardStats.totalIndexed > 0
                    ? `${Math.round(((dashboardStats.withoutDecision || 0) / dashboardStats.totalIndexed) * 100)}% do catálogo`
                    : "—"}
                </Text>
              </BlockStack>
            </Card>

            <Card className="alterpop-fade-in">
              <BlockStack gap="100">
                <Text as="p" tone="subdued" variant="bodySm">
                  Taxa de Aprovação
                </Text>
                <Text as="p" variant="headingLg">
                  {`${Math.round((dashboardStats.approvalRate || 0) * 100)}%`}
                </Text>
                <ProgressBar
                  progress={Math.round((dashboardStats.approvalRate || 0) * 100)}
                  tone={(dashboardStats.approvalRate || 0) >= 0.3 ? "success" : "warning"}
                />
                {(dashboardStats.totalApproved || 0) === 0 && (dashboardStats.totalRejected || 0) === 0 && (
                  <Text as="p" tone="subdued" variant="bodySm">
                    Ainda sem decisões — 0% porque não há aprovados nem rejeitados.
                  </Text>
                )}
              </BlockStack>
            </Card>

            <Card className="alterpop-fade-in">
              <BlockStack gap="100">
                <Text as="p" tone="subdued" variant="bodySm">
                  Preço Médio Aprovados
                </Text>
                <Text
                  as="p"
                  variant="headingLg"
                  tone={(dashboardStats.avgApprovedNetPrice || 0) === 0 ? "subdued" : undefined}
                >
                  {formatEur(dashboardStats.avgApprovedNetPrice || 0)}
                </Text>
              </BlockStack>
            </Card>
          </div>

          <Layout>
            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Radar de vendas (30d)
                  </Text>
                  <Text as="p" tone="subdued">
                    Atualiza as unidades vendidas nos últimos 30 dias por SKU, a partir das
                    encomendas da Shopify. Os números aparecem depois como badge por produto na
                    Curadoria.
                  </Text>
                  <div>
                    <Button onClick={refreshSales} disabled={salesRefreshing} loading={salesRefreshing}>
                      {salesRefreshing ? "A atualizar…" : "Atualizar Radar de Vendas (30d)"}
                    </Button>
                  </div>
                  {lastSalesResult != null && (
                    <Text as="p" tone="subdued">
                      {`Última atualização: ${lastSalesResult} SKU(s) com vendas nos últimos 30 dias.`}
                    </Text>
                  )}
                </BlockStack>
              </Card>
            </Layout.Section>
          </Layout>

          <LastSyncRunBanner />
          <SyncErrorLogsPanel />
        </BlockStack>
      </Page>
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
