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
import { OrderStockAlertsPanel } from "../components/OrderStockAlertsPanel.jsx";
import { listSkusForReview } from "../../lib/importer/catalog/skuLifecycle.server.js";
import { computeMarginErosionAlerts } from "../../lib/importer/curation/marginErosion.server.js";
import { listAutoCollections } from "../../lib/importer/shopify/autoCollections.server.js";
import { loadShopSettings } from "../../lib/importer/settings.server.js";

export const loader = async ({ request }) => {
  const { session } = await authenticateAdmin(request);
  const [dashboardStats, settings] = await Promise.all([
    getDashboardStats(session.shop),
    loadShopSettings(session.shop),
  ]);
  const [discontinuedForReview, marginErosionAlerts, autoCollections] = await Promise.all([
    listSkusForReview(session.shop),
    computeMarginErosionAlerts(session.shop, { thresholdPct: settings.marginErosionThresholdPct }),
    listAutoCollections(session.shop),
  ]);
  return {
    shop: session.shop,
    dashboardStats,
    discontinuedForReview,
    marginErosionAlerts,
    autoCollections,
    marginErosionThresholdPct: settings.marginErosionThresholdPct,
  };
};

export default function ReportsPage() {
  const {
    dashboardStats,
    discontinuedForReview,
    marginErosionAlerts,
    autoCollections,
    marginErosionThresholdPct,
  } = useLoaderData();
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

          <Layout>
            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    {`Descontinuados para revisão (${discontinuedForReview.length})`}
                  </Text>
                  <Text as="p" tone="subdued">
                    SKUs que já apareceram no catálogo mas faltam há 3+ ciclos consecutivos do
                    fornecedor (~2h15). Marcados só para revisão manual — nada é despublicado
                    automaticamente ainda.
                  </Text>
                  {discontinuedForReview.length === 0 ? (
                    <Text as="p" tone="subdued">Sem candidatos a descontinuado neste momento.</Text>
                  ) : (
                    <BlockStack gap="150">
                      {discontinuedForReview.slice(0, 30).map((r) => (
                        <Text as="p" key={r.sku} tone="subdued">
                          {`${r.sku}${r.vendor ? ` · ${r.vendor}` : ""} — ausente há ${r.missingCycles} ciclos`}
                        </Text>
                      ))}
                      {discontinuedForReview.length > 30 && (
                        <Text as="p" tone="subdued">{`+ ${discontinuedForReview.length - 30} outro(s)…`}</Text>
                      )}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>
            </Layout.Section>
          </Layout>

          <Layout>
            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    {`Erosão de margem (${marginErosionAlerts.length})`}
                  </Text>
                  <Text as="p" tone="subdued">
                    {`Produtos publicados cujo custo do fornecedor subiu ${marginErosionThresholdPct}%+ desde a publicação (limiar configurável em Definições). Só sinaliza — preço e stock nunca são alterados automaticamente.`}
                  </Text>
                  {marginErosionAlerts.length === 0 ? (
                    <Text as="p" tone="subdued">Sem alertas de erosão de margem neste momento.</Text>
                  ) : (
                    <BlockStack gap="150">
                      {marginErosionAlerts.slice(0, 30).map((a) => (
                        <Text as="p" key={a.sku} tone="subdued">
                          {`${a.sku} — ${formatEur(a.costAtPublish)} → ${formatEur(a.currentCost)} (+${a.erosionPct}%)`}
                        </Text>
                      ))}
                      {marginErosionAlerts.length > 30 && (
                        <Text as="p" tone="subdued">{`+ ${marginErosionAlerts.length - 30} outro(s)…`}</Text>
                      )}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>
            </Layout.Section>
          </Layout>

          <Layout>
            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    {`Coleções automáticas por licença (${autoCollections.length})`}
                  </Text>
                  <Text as="p" tone="subdued">
                    Criadas em rascunho quando uma licença atinge 10+ produtos publicados. Nunca
                    ficam visíveis na loja sem confirmares e publicares manualmente num canal de
                    vendas no Admin.
                  </Text>
                  {autoCollections.length === 0 ? (
                    <Text as="p" tone="subdued">Nenhuma licença atingiu o limiar ainda.</Text>
                  ) : (
                    <BlockStack gap="150">
                      {autoCollections.map((c) => (
                        <Text as="p" key={c.licenceKey} tone="subdued">
                          {`${c.licenceLabel} — ${c.productCountAtCreate} produtos (criada ${new Date(c.createdAt).toLocaleDateString("pt-PT")})`}
                        </Text>
                      ))}
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>
            </Layout.Section>
          </Layout>

          <LastSyncRunBanner />
          <OrderStockAlertsPanel />
          <SyncErrorLogsPanel />
        </BlockStack>
      </Page>
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
