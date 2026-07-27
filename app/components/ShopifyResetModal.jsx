import { useCallback, useEffect, useState } from "react";
import {
  Modal,
  BlockStack,
  Text,
  ProgressBar,
  Banner,
  TextField,
  List,
} from "@shopify/polaris";

const CONFIRM_WORD = "APAGAR";

/**
 * @param {{
 *   open: boolean,
 *   onClose: () => void,
 *   onStarted?: () => void,
 *   onComplete?: (status: object) => void,
 * }} props
 */
export function ShopifyResetModal({ open, onClose, onStarted, onComplete }) {
  const [confirmText, setConfirmText] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState(null);
  const [status, setStatus] = useState(null);
  const [pollError, setPollError] = useState(null);
  const [resetStarted, setResetStarted] = useState(false);
  const [previewCount, setPreviewCount] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);

  const confirmed = confirmText.trim().toUpperCase() === CONFIRM_WORD;
  const running =
    status?.state === "running" ||
    status?.state === "listing" ||
    status?.state === "deleting";

  useEffect(() => {
    if (!open) {
      setConfirmText("");
      setStartError(null);
      setStatus(null);
      setPollError(null);
      setResetStarted(false);
      setPreviewCount(null);
      setPreviewLoading(false);
      setPreviewError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open || resetStarted) return;

    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);

    fetch("/api/shopify-reset?preview=1", { credentials: "same-origin" })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (!data?.ok) {
          setPreviewError(data?.error || "Não foi possível contar produtos.");
          return;
        }
        setPreviewCount(
          typeof data.previewCount === "number" ? data.previewCount : null
        );
      })
      .catch((err) => {
        if (!cancelled) {
          setPreviewError(err?.message || "Falha ao contar produtos.");
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, resetStarted]);

  const handleStartReset = useCallback(async () => {
    if (!confirmed || starting) return;
    setStarting(true);
    setStartError(null);

    try {
      const res = await fetch("/api/shopify-reset", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ confirm: CONFIRM_WORD }),
      });
      const data = await res.json();

      if (!res.ok || !data?.ok) {
        setStartError(data?.error || "Não foi possível iniciar o reset.");
        return;
      }

      setStatus(data.status);
      setResetStarted(true);
      onStarted?.();
    } catch (err) {
      setStartError(err?.message || "Falha de rede");
    } finally {
      setStarting(false);
    }
  }, [confirmed, starting]);

  useEffect(() => {
    if (!open || !resetStarted) return;

    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch("/api/shopify-reset", { credentials: "same-origin" });
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
  }, [open, resetStarted, status?.state, onComplete]);

  const total = status?.total || 0;
  const processed = status?.processed || 0;
  const deleted = status?.deleted || 0;
  const failed = status?.failed || 0;
  const progress =
    total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const done = status?.state === "completed";
  const failedJob = status?.state === "failed";
  const showProgress = running || done || failedJob;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Reset Shopify Catalog"
      primaryAction={
        showProgress
          ? {
              content: done || failedJob ? "Fechar" : "Minimizar",
              onAction: onClose,
            }
          : {
              content: starting ? "A iniciar…" : "Apagar produtos na Shopify",
              onAction: handleStartReset,
              destructive: true,
              disabled: !confirmed || starting,
            }
      }
      secondaryActions={
        showProgress
          ? undefined
          : [{ content: "Cancelar", onAction: onClose, disabled: starting }]
      }
    >
      <Modal.Section>
        <BlockStack gap="400">
          <Banner tone="critical">
            <p>
              <strong>Tem a certeza?</strong> Isto vai apagar{" "}
              <strong>TODOS os produtos</strong> da loja Shopify — catálogo completo,
              não apenas os com tags da app. Esta acção é{" "}
              <strong>permanente</strong> e irreversível na Shopify.
            </p>
          </Banner>

          {!showProgress && (
            <>
              {previewLoading && (
                <Text as="p" tone="subdued" variant="bodySm">
                  A contar produtos na loja…
                </Text>
              )}
              {!previewLoading && previewCount != null && (
                <Banner tone="warning">
                  {`Serão apagados ${previewCount} produto(s) na Shopify (catálogo completo).`}
                </Banner>
              )}
              {previewError && <Banner tone="critical">{previewError}</Banner>}
              <Text as="p" variant="bodyMd">
                A listagem usa a API Admin (paginação de todos os produtos). Após o
                reset, os itens <strong>PUBLISHED</strong> na fila local voltam a{" "}
                <strong>APPROVED</strong> para republicação limpa.
              </Text>
              <TextField
                label={`Escreve "${CONFIRM_WORD}" para confirmar`}
                value={confirmText}
                onChange={setConfirmText}
                autoComplete="off"
                placeholder={CONFIRM_WORD}
              />
              {startError && <Banner tone="critical">{startError}</Banner>}
            </>
          )}

          {showProgress && (
            <>
              <Text as="p" variant="bodyMd">
                {running
                  ? `A apagar produtos da Shopify… ${processed} / ${total} concluídos`
                  : `Concluído: ${processed} / ${total}`}
              </Text>
              <ProgressBar progress={progress} size="small" tone="primary" />
              {status?.currentTitle && running && (
                <Text as="p" tone="subdued" variant="bodySm">
                  {status.currentTitle}
                </Text>
              )}
            </>
          )}

          {done && (
            <Banner tone={failed > 0 ? "warning" : "success"}>
              {`Reset concluído: ${deleted} produto(s) apagado(s) na Shopify, ${failed} falha(s). ${status?.revertedLocal ?? 0} registo(s) local(is) revertido(s) para APPROVED.`}
            </Banner>
          )}

          {failedJob && (
            <Banner tone="critical">
              {status?.error || "O reset falhou de forma inesperada."}
            </Banner>
          )}

          {pollError && <Banner tone="warning">{pollError}</Banner>}

          {status?.recentErrors?.length > 0 && (
            <BlockStack gap="200">
              <Text as="p" variant="headingSm">
                Últimas falhas
              </Text>
              <List type="bullet">
                {status.recentErrors.slice(-6).map((e) => (
                  <List.Item key={`${e.productId}-${e.message?.slice(0, 20)}`}>
                    {`${e.productId}: ${e.message}`}
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
