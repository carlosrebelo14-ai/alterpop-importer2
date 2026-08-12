import { useEffect, useState } from "react";
import { Card, ResourceList, ResourceItem, Text, BlockStack, Banner, Button, InlineStack } from "@shopify/polaris";

/**
 * Item 18 do roadmap — encomendas onde a quantidade pedida excede o stock
 * indexado localmente. Heurística sobre dados que podem estar até 45 minutos
 * desactualizados (ciclo do relógio) — NÃO é confirmação real do fornecedor,
 * e NADA é cancelado automaticamente. Só um alerta para revisão manual.
 */
export function OrderStockAlertsPanel() {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/order-stock-alerts?resolved=0", { credentials: "same-origin" });
      const data = await res.json();
      if (data?.ok) setAlerts(data.alerts || []);
    } catch {
      setAlerts([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const timer = setInterval(load, 30000);
    return () => clearInterval(timer);
  }, []);

  async function resolve(id) {
    const form = new FormData();
    form.set("intent", "resolve");
    form.set("id", id);
    await fetch("/api/order-stock-alerts", { method: "POST", body: form, credentials: "same-origin" });
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  }

  if (!loading && alerts.length === 0) return null;

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          Encomendas a Rever
        </Text>
        <Banner tone="warning">
          <Text as="p">
            Heurística sobre o stock indexado localmente — pode estar até 45 minutos desactualizado
            face ao fornecedor real. Nada é cancelado automaticamente; confirma manualmente antes de
            agir.
          </Text>
        </Banner>
        <ResourceList
          resourceName={{ singular: "alerta", plural: "alertas" }}
          items={alerts}
          renderItem={(a) => (
            <ResourceItem id={a.id}>
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="050">
                  <Text as="p" fontWeight="semibold">
                    Encomenda {a.orderName} — SKU {a.sku}
                  </Text>
                  <Text as="p" tone="subdued">
                    Pedido: {a.orderedQty} · Stock indexado: {a.indexedStock} ·{" "}
                    {new Date(a.createdAt).toLocaleString("pt-PT")}
                  </Text>
                </BlockStack>
                <Button size="slim" onClick={() => resolve(a.id)}>
                  Marcar como revisto
                </Button>
              </InlineStack>
            </ResourceItem>
          )}
        />
      </BlockStack>
    </Card>
  );
}
