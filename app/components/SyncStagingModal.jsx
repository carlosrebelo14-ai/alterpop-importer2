import {
  Modal,
  BlockStack,
  Text,
  Banner,
  List,
} from "@shopify/polaris";
import { formatEur } from "../../lib/importer/catalog/categoryLabel.js";

/**
 * @param {{
 *   open: boolean,
 *   onClose: () => void,
 *   onConfirm: () => void,
 *   loading?: boolean,
 *   confirming?: boolean,
 *   summary: object | null,
 *   liveMode?: boolean,
 * }} props
 */
export function SyncStagingModal({
  open,
  onClose,
  onConfirm,
  loading,
  confirming,
  summary,
  liveMode = false,
}) {
  const title = liveMode
    ? "Confirmar sincronização com Shopify"
    : "Resumo de importação (staging)";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      primaryAction={{
        content: liveMode ? "Sim, enviar para Shopify" : "Iniciar sincronização",
        // Sem tags por lote: os produtos só levam "alterpop" (opção A, 29/09/2026).
        onAction: () => onConfirm(),
        loading: confirming,
        disabled: loading || !summary?.approvedCount,
      }}
      secondaryActions={[{ content: "Cancelar", onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          {loading && (
            <Text as="p" tone="subdued">
              A calcular resumo dos produtos aprovados…
            </Text>
          )}

          {!loading && summary && (
            <>
              <Text as="p" variant="headingMd">
                Resumo de importação
              </Text>
              <List type="bullet">
                <List.Item>
                  {`${summary.approvedCount.toLocaleString("pt-PT")} produtos aprovados`}
                  {summary.foundCount < summary.approvedCount
                    ? ` (${summary.foundCount} encontrados no catálogo)`
                    : ""}
                </List.Item>
                <List.Item>
                  {`Custo total (precio_distribuidores + IVA): ${formatEur(summary.totalCostEur)}`}
                </List.Item>
                <List.Item>
                  {`Receita alvo (margem ${summary.marginPct ?? "—"}%): ${formatEur(summary.totalTargetRetailEur)}`}
                </List.Item>
                <List.Item>
                  {`Lucro alvo: ${formatEur(summary.totalProfitEur)}`}
                </List.Item>
              </List>

              {summary.priceErrorSkus?.length > 0 && (
                <Banner tone="critical">
                  {`${summary.priceErrorSkus.length} SKU(s) sem precio_distribuidores — não têm preço e falham na publicação: ${summary.priceErrorSkus.slice(0, 10).join(", ")}`}
                </Banner>
              )}

              {(summary.statusCounts?.ACIMA_PVPR > 0 ||
                summary.statusCounts?.TETO > 0 ||
                summary.statusCounts?.PISO_PVPR > 0 ||
                summary.statusCounts?.SEM_PVPR > 0) && (
                <Banner tone={summary.statusCounts?.ACIMA_PVPR > 0 ? "warning" : "info"}>
                  {[
                    summary.statusCounts?.TETO > 0 ? `${summary.statusCounts.TETO} no teto do PVPR` : null,
                    summary.statusCounts?.PISO_PVPR > 0 ? `${summary.statusCounts.PISO_PVPR} no piso de 80 % do PVPR` : null,
                    summary.statusCounts?.SEM_PVPR > 0 ? `${summary.statusCounts.SEM_PVPR} sem PVPR no feed` : null,
                    summary.statusCounts?.ACIMA_PVPR > 0 ? `${summary.statusCounts.ACIMA_PVPR} acima do PVPR (nem a margem mínima cabe)` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Banner>
              )}

              {summary.missingSkus?.length > 0 && (
                <Banner tone="warning">
                  {`${summary.missingSkus.length} SKU(s) aprovados não estão no índice do catálogo — serão ignorados até reindexar.`}
                </Banner>
              )}

              <Banner tone={liveMode ? "warning" : "info"}>
                {liveMode
                  ? "Os pedidos serão enviados em lotes de 20 produtos com pausa de 1s entre lotes. Falhas individuais não param o resto do processo."
                  : "Primeiro passo: simulação (dry-run). Após concluir, podes confirmar o envio real para a Shopify."}
              </Banner>
            </>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
