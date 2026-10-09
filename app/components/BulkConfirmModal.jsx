import { useEffect, useState } from "react";
import { BlockStack, Banner, Modal, Text } from "@shopify/polaris";
import { BulkActionConfirm } from "./BulkActionConfirm.jsx";
import { BULK_CONFIRM_THRESHOLD, BULK_SAMPLE_SIZE, isBulkConfirmed } from "../../lib/curation/bulkConfirm.js";

/**
 * O modal de confirmação das ações em massa (D1): aprovar, rejeitar e publicar. Diz o número
 * exato, o âmbito por extenso e uma amostra de 5 SKUs; acima de 50 exige escrever o número
 * (BulkActionConfirm). O servidor verifica o mesmo número (confirmCount) e recusa se diferir.
 *
 * @param {{
 *   open: boolean, title: string, confirmLabel: string, destructive?: boolean,
 *   scope: number, scopeText: string, sample: Array<{ sku: string, title?: string|null }>,
 *   loading?: boolean, busy?: boolean, error?: string|null,
 *   onConfirm: (confirmCount: number) => void, onClose: () => void,
 * }} props
 */
export function BulkConfirmModal({ open, title, confirmLabel, destructive = false, scope, scopeText, sample, loading = false, busy = false, error = null, onConfirm, onClose }) {
  const [typed, setTyped] = useState("");
  useEffect(() => {
    setTyped("");
  }, [open, scope]);

  const ready = !loading && scope > 0 && isBulkConfirmed(scope, typed);
  const shown = (sample || []).slice(0, BULK_SAMPLE_SIZE);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      primaryAction={{
        content: loading ? "A contar…" : `${confirmLabel} ${scope.toLocaleString("pt-PT")}`,
        destructive,
        onAction: () => onConfirm(scope),
        loading: busy,
        disabled: !ready || busy,
      }}
      secondaryActions={[{ content: "Cancelar", onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          {error && <Banner tone="critical">{error}</Banner>}
          {loading ? (
            <Text as="p" tone="subdued">A contar os produtos do âmbito…</Text>
          ) : (
            <>
              <Text as="p" variant="bodyMd">
                Esta ação aplica-se a <strong>{scope.toLocaleString("pt-PT")} produto(s)</strong>, não só à página atual.
              </Text>
              {scope <= BULK_CONFIRM_THRESHOLD && <Text as="p" tone="subdued">Âmbito: {scopeText}</Text>}
              {shown.length > 0 && scope <= BULK_CONFIRM_THRESHOLD && (
                <Text as="p" variant="bodySm" tone="subdued">
                  {`Amostra: ${shown.map((s) => s.sku).join(", ")}`}
                </Text>
              )}
              <BulkActionConfirm
                scope={scope}
                scopeText={scopeText}
                sampleSkus={shown.map((s) => s.sku)}
                typed={typed}
                onTyped={setTyped}
                verb={confirmLabel.toLowerCase()}
              />
            </>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
