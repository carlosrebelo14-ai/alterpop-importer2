import { useEffect, useState } from "react";
import {
  Card,
  ResourceList,
  ResourceItem,
  Text,
  BlockStack,
  Banner,
  Button,
  InlineStack,
} from "@shopify/polaris";

/**
 * @param {{ onRetryJob?: (jobId: string) => void, lastJobId?: string | null }} props
 */
export function SyncErrorLogsPanel({ onRetryJob, lastJobId }) {
  const [errors, setErrors] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const res = await fetch("/api/sync/errors?limit=200", { credentials: "same-origin" });
        const data = await res.json();
        if (!cancelled && data?.ok) setErrors(data.errors || []);
      } catch {
        if (!cancelled) setErrors([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    const timer = setInterval(load, 8000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">
            Logs de Erro
          </Text>
          {lastJobId && onRetryJob && (
            <Button size="slim" onClick={() => onRetryJob(lastJobId)}>
              Retry falhas do último job
            </Button>
          )}
        </InlineStack>

        <Text as="p" tone="subdued">
          Erros de sincronização Shopify (imagem inválida, SKU duplicado, API, etc.). Passa o rato
          sobre o ícone ! na lista de produtos para ver o detalhe por SKU.
        </Text>

        {loading ? (
          <Text as="p" tone="subdued">
            A carregar…
          </Text>
        ) : errors.length === 0 ? (
          <Banner tone="success">Sem erros registados recentemente.</Banner>
        ) : (
          <ResourceList
            resourceName={{ singular: "erro", plural: "erros" }}
            items={errors}
            renderItem={(item) => (
              <ResourceItem id={item.id} accessibilityLabel={item.sku}>
                <BlockStack gap="100">
                  <Text as="span" fontWeight="semibold">
                    {`${item.label} · SKU ${item.sku}`}
                  </Text>
                  <Text as="p" tone="subdued">
                    {item.message}
                  </Text>
                  <Text as="p" tone="subdued" variant="bodySm">
                    {item.jobId ? `Job ${item.jobId} · ` : ""}
                    {new Date(item.createdAt).toLocaleString("pt-PT")}
                  </Text>
                </BlockStack>
              </ResourceItem>
            )}
          />
        )}
      </BlockStack>
    </Card>
  );
}
