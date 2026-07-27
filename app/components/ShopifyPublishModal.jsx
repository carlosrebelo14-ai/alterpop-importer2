import { useEffect, useState } from "react";
import { Modal, BlockStack, Text, ProgressBar, Banner, List } from "@shopify/polaris";

/**
 * @param {{
 *   open: boolean,
 *   onClose: () => void,
 *   jobId: string | null,
 *   onComplete?: (status: object) => void,
 * }} props
 */
export function ShopifyPublishModal({ open, onClose, jobId, onComplete }) {
  const [status, setStatus] = useState(null);
  const [pollError, setPollError] = useState(null);

  useEffect(() => {
    if (!open || !jobId) return;

    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch("/api/shopify-sync", { credentials: "same-origin" });
        const data = await res.json();
        if (cancelled || !data?.ok) return;

        setStatus(data.status);
        setPollError(null);

        if (data.status?.state === "completed" || data.status?.state === "failed") {
          onComplete?.(data.status);
        }
      } catch (err) {
        if (!cancelled) {
          setPollError(err?.message || "Falha ao obter progresso");
        }
      }
    };

    poll();
    const timer = setInterval(poll, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, jobId, onComplete]);

  const total = status?.total || 0;
  const processed = status?.processed || 0;
  const published = status?.published || 0;
  const failed = status?.failed || 0;
  const progress =
    total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const running = status?.state === "running";
  const done = status?.state === "completed";
  const failedJob = status?.state === "failed";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Publicar na Shopify"
      primaryAction={{
        content: done || failedJob ? "Fechar" : "Minimizar",
        onAction: onClose,
      }}
    >
      <Modal.Section>
        <BlockStack gap="400">
          {running && (
            <>
              <Text as="p" variant="bodyMd">
                {status?.currentSku
                  ? `A sincronizar: ${processed} / ${total} — ${status.currentSku}`
                  : `A sincronizar: ${processed} / ${total} produtos…`}
              </Text>
              <ProgressBar progress={progress} size="small" />
            </>
          )}

          {done && (
            <Banner tone={failed > 0 ? "warning" : "success"}>
              {`Sincronização concluída: ${published} produto(s) publicado(s) com sucesso, ${failed} falha(s).`}
            </Banner>
          )}

          {failedJob && (
            <Banner tone="critical">
              {status?.error || "A sincronização falhou de forma inesperada."}
            </Banner>
          )}

          {pollError && (
            <Banner tone="warning">{pollError}</Banner>
          )}

          {status?.recentErrors?.length > 0 && (
            <BlockStack gap="200">
              <Text as="p" variant="headingSm">
                Últimas falhas
              </Text>
              <List type="bullet">
                {status.recentErrors.slice(-8).map((e) => (
                  <List.Item key={`${e.sku}-${e.message?.slice(0, 24)}`}>
                    {`${e.sku}: ${e.message}`}
                  </List.Item>
                ))}
              </List>
            </BlockStack>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
