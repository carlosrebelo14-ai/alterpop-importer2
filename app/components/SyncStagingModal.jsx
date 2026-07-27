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
        onAction: onConfirm,
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
                  {`Custo total estimado: ${formatEur(summary.totalCostEur)}`}
                </List.Item>
                <List.Item>
                  {`Receita alvo (margem 40%): ${formatEur(summary.totalTargetRetailEur)}`}
                </List.Item>
                <List.Item>
                  {summary.averageMarginPercent != null
                    ? `Margem média alvo: ${summary.averageMarginPercent}%`
                    : "Margem média: — (sem preços de custo)"}
                </List.Item>
              </List>

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
