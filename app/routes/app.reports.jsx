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
import { loadMarginErosionState } from "../../lib/importer/curation/marginErosion.server.js";

export const loader = async ({ request }) => {
  const { session } = await authenticateAdmin(request);
  const [dashboardStats, discontinuedForReview] = await Promise.all([
    getDashboardStats(session.shop),
    listSkusForReview(session.shop),
  ]);
  // Estado gravado pelo último ciclo (api.trigger-sync). Ficheiro ilegível lança —
  // a página mostra o erro em vez de "sem alertas".
  let marginErosion = null;
  let marginErosionError = null;
  let marginErosionFailedAt = null;
  try {
    const state = await loadMarginErosionState(session.shop);
    if (state?.status === "failed") {
      // Último ciclo falhou: mostra a falha e, abaixo, o último resultado bom (se houver).
      // A hora vai crua e é formatada no componente, no mesmo fuso das outras.
      marginErosionError = state.reason;
      marginErosionFailedAt = state.ranAt;
      marginErosion = state.lastGood || null;
    } else {
      marginErosion = state;
    }
  } catch (err) {
    marginErosionError = err?.message || String(err);
  }
  // Ciclo do relógio ~45 min; acima de 3 h sem medir, o estado já não descreve a loja.
  const marginErosionStale =
    marginErosion?.ranAt != null && Date.now() - new Date(marginErosion.ranAt).getTime() > 3 * 60 * 60 * 1000;
  return {
    shop: session.shop,
    dashboardStats,
    discontinuedForReview,
    marginErosion,
    marginErosionError,
    marginErosionFailedAt,
    marginErosionStale,
  };
};

export default function ReportsPage() {
  const {
    dashboardStats,
    discontinuedForReview,
    marginErosion,
    marginErosionError,
    marginErosionFailedAt,
    marginErosionStale,
  } = useLoaderData();
  // Mesmo fuso no servidor e no browser — horas da falha e do último ciclo comparáveis.
  const fmtLisbon = (iso) => new Date(iso).toLocaleString("pt-PT", { timeZone: "Europe/Lisbon" });
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

          {dashboardStats.approvedPricingError && (
            <Banner tone="critical">
              {`Receita e lucro dos aprovados não calculados: ${dashboardStats.approvedPricingError}`}
            </Banner>
          )}
          {(dashboardStats.approvedPriceErrorCount || 0) > 0 && (
            <Banner tone="warning">
              {`${dashboardStats.approvedPriceErrorCount} aprovado(s) sem precio_distribuidores — fora da receita e do lucro abaixo, e falham na publicação.`}
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
                    {`Erosão de margem (${marginErosion?.red?.length ?? "—"})`}
                  </Text>
                  <Text as="p" tone="subdued">
                    {`Em cada ciclo, compara o preço live de cada produto publicado com o custo atual do feed (precio_distribuidores + IVA). Vermelho abaixo de ${marginErosion?.thresholdPct ?? 10}% de margem efetiva sobre o custo. Só sinaliza — o preço nunca é alterado automaticamente.`}
                  </Text>
                  {marginErosionError && (
                    <Banner tone="critical">
                      {marginErosionFailedAt
                        ? `Erosão de margem: o ciclo de ${fmtLisbon(marginErosionFailedAt)} falhou — ${marginErosionError}. Abaixo, o último resultado bom.`
                        : `Erosão de margem: ${marginErosionError}`}
                    </Banner>
                  )}
                  {marginErosionStale && (
                    <Banner tone="warning">Último ciclo com mais de 3 h — os valores abaixo podem já não descrever a loja.</Banner>
                  )}
                  {!marginErosion ? (
                    marginErosionError ? null : (
                      <Text as="p" tone="subdued">Ainda nenhum ciclo mediu a margem — aparece depois do próximo ciclo de sync.</Text>
                    )
                  ) : (
                    <BlockStack gap="200">
                      <Text as="p" tone="subdued">
                        {`Último ciclo medido: ${fmtLisbon(marginErosion.ranAt)} · ${marginErosion.measured}/${marginErosion.publishedCount} publicados medidos.`}
                      </Text>
                      {marginErosion.red.length === 0 ? (
                        <Text as="p" tone="success">{`Nenhum produto abaixo de ${marginErosion.thresholdPct}% de margem efetiva.`}</Text>
                      ) : (
                        <BlockStack gap="150">
                          {marginErosion.red.slice(0, 50).map((a) => (
                            <Text as="p" key={a.sku} tone="critical">
                              {`${a.sku} — ${a.title}: live ${formatEur(a.livePrice)}, custo ${formatEur(a.cost)} → margem ${a.effectiveMarginPct}%`}
                            </Text>
                          ))}
                          {marginErosion.red.length > 50 && (
                            <Text as="p" tone="subdued">{`+ ${marginErosion.red.length - 50} outro(s)…`}</Text>
                          )}
                        </BlockStack>
                      )}
                      {marginErosion.overridesNotApplied?.length > 0 && (
                        <Banner tone="warning" title={`${marginErosion.overridesNotApplied.length} preço(s) fixado(s) na curadoria que não estão na loja`}>
                          <BlockStack gap="100">
                            <Text as="p">
                              O preço fixado só se aplica quando o produto é criado. Num produto que já existe, muda-o no admin da Shopify — ou limpa o override.
                            </Text>
                            {marginErosion.overridesNotApplied.slice(0, 20).map((a) => (
                              <Text as="p" key={a.sku}>{`${a.sku} — ${a.title}: fixado ${formatEur(a.override)}, na loja ${formatEur(a.livePrice)}`}</Text>
                            ))}
                            {marginErosion.overridesNotApplied.length > 20 && (
                              <Text as="p">{`+ ${marginErosion.overridesNotApplied.length - 20} outro(s)…`}</Text>
                            )}
                          </BlockStack>
                        </Banner>
                      )}
                      {marginErosion.noData.length > 0 && (
                        <Banner tone="warning" title={`${marginErosion.noData.length} publicado(s) sem dados para medir`}>
                          <BlockStack gap="100">
                            {marginErosion.noData.slice(0, 20).map((a) => (
                              <Text as="p" key={a.sku}>{`${a.sku} — ${a.reason}`}</Text>
                            ))}
                            {marginErosion.noData.length > 20 && (
                              <Text as="p">{`+ ${marginErosion.noData.length - 20} outro(s)…`}</Text>
                            )}
                          </BlockStack>
                        </Banner>
                      )}
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
