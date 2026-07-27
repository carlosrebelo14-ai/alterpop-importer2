import { useState } from "react";
import { BlockStack, Text, Button, Box } from "@shopify/polaris";

const REJECTION_LABELS = {
  missingData: "Dados em falta (SKU inválido)",
  outOfStock: "Sem stock / sem marca válida",
  badCategory: "Categoria bloqueada ou têxtil genérico",
  lowPrice: "Preço abaixo do mínimo (4€)",
  blockedBrand: "Marca bloqueada (mass-market)",
  liquidation: "Liquidação / clearance",
  other: "Outros motivos",
};

/**
 * Relatório de auditoria pós-indexação.
 * @param {{ audit: object | null }} props
 */
export function IndexingAuditReport({ audit }) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  if (!audit) return null;

  const totalLinesRead = audit.totalLinesRead ?? 0;
  const totalImported = audit.totalImported ?? 0;
  const totalRejected =
    audit.totalRejected ??
    Math.max(0, totalLinesRead - totalImported);

  const reasons = audit.rejectionReasons || {};
  const reasonEntries = Object.entries(reasons).filter(([, n]) => n > 0);

  return (
    <Box
      padding="300"
      background="bg-surface-secondary"
      borderRadius="200"
      borderWidth="025"
      borderColor="border"
    >
      <BlockStack gap="300">
        <Text as="h3" variant="headingSm">
          Análise concluída
        </Text>

        <BlockStack gap="100">
          <Text as="p" variant="bodySm">
            {`Total de linhas lidas: ${totalLinesRead.toLocaleString("pt-PT")}`}
          </Text>
          <Text as="p" variant="bodySm" tone="success">
            {`Produtos importados: ${totalImported.toLocaleString("pt-PT")}`}
          </Text>
          <Text as="p" variant="bodySm" tone="critical">
            {`Produtos rejeitados: ${totalRejected.toLocaleString("pt-PT")}`}
          </Text>
        </BlockStack>

        {reasonEntries.length > 0 && (
          <>
            <Button
              size="slim"
              onClick={() => setDetailsOpen((v) => !v)}
              disclosure={detailsOpen ? "up" : "down"}
            >
              Ver detalhes da rejeição
            </Button>

            {detailsOpen && (
              <BlockStack gap="150">
                {reasonEntries
                  .sort((a, b) => b[1] - a[1])
                  .map(([key, count]) => (
                    <Text key={key} as="p" variant="bodySm" tone="subdued">
                      {`${count.toLocaleString("pt-PT")} — ${REJECTION_LABELS[key] || key}`}
                    </Text>
                  ))}
              </BlockStack>
            )}
          </>
        )}
      </BlockStack>
    </Box>
  );
}
