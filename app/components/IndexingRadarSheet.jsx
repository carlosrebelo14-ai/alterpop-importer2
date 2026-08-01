/* eslint-disable react/prop-types */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Text, BlockStack, InlineStack, Box, Button } from "@shopify/polaris";
import { CatalogProductThumbnail } from "./CatalogProductThumbnail.jsx";
import { IndexingAuditReport } from "./IndexingAuditReport.jsx";

const MAX_ITEMS = 20;
const PANEL_WIDTH = 340;

/**
 * Painel fixo à direita — radar de indexação (SSE), renderizado via Portal para document.body.
 */
export function IndexingRadarSheet({
  open,
  indexing = false,
  onClose,
  onIndexingChange,
  onIndexingComplete,
  onReindexCatalog,
  onPauseIndexing,
}) {
  const [items, setItems] = useState([]);
  const [indexed, setIndexed] = useState(0);
  const [scanned, setScanned] = useState(0);
  const [phase, setPhase] = useState("idle");
  const [connected, setConnected] = useState(false);
  const [auditReport, setAuditReport] = useState(null);
  const esRef = useRef(null);

  const connectStream = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const es = new EventSource("/api/indexing-stream", { withCredentials: true });
    esRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    es.onmessage = (ev) => {
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (data.type === "status") {
        const isRebuilding = Boolean(data.rebuilding ?? data.indexing);
        onIndexingChange?.(isRebuilding);
        const currentScanned = data.scanned ?? data.totalLinesRead ?? data.checkpointScanned ?? 0;
        const currentIndexed = data.indexed ?? data.totalImported ?? data.checkpointIndexed ?? data.totalRows ?? 0;
        setScanned(currentScanned);
        setIndexed(currentIndexed);
        setPhase(data.phase || (data.state === "completed" ? "done" : isRebuilding ? "streaming" : "idle"));
        if (data.audit || data.state === "completed") {
          setAuditReport(data.audit || {
            totalLinesRead: currentScanned,
            totalImported: currentIndexed,
            totalRejected: data.totalRejected ?? 0,
            rejectionReasons: data.rejectionReasons ?? {},
          });
        }
      }

      if (data.type === "started") {
        setAuditReport(null);
        setPhase("streaming");
      }

      if (data.type === "started" || data.type === "progress") {
        onIndexingChange?.(true);
        if (data.phase) setPhase(data.phase);
        if (data.indexed != null) setIndexed(data.indexed);
        if (data.scanned != null) setScanned(data.scanned);
        if (data.resumedFrom != null && data.resumedFrom > 0) {
          setScanned((prev) => Math.max(prev, data.resumedFrom));
        }
      }

      if (data.type === "product" && data.product) {
        const p = data.product;
        setItems((prev) => {
          const next = [{ ...p, at: Date.now() }, ...prev.filter((x) => x.sku !== p.sku)];
          return next.slice(0, MAX_ITEMS);
        });
      }

      if (data.type === "done") {
        setPhase("done");
        onIndexingChange?.(false);
        if (data.indexed != null) setIndexed(data.indexed);
        if (data.scanned != null) setScanned(data.scanned);
        setAuditReport({
          totalLinesRead: data.totalLinesRead ?? data.scanned ?? 0,
          totalImported: data.totalImported ?? data.indexed ?? 0,
          totalRejected: data.totalRejected ?? 0,
          rejectionReasons: data.rejectionReasons ?? data.audit?.rejectionReasons ?? {},
        });
        onIndexingComplete?.();
      }

      if (data.type === "error") {
        setPhase("error");
        onIndexingChange?.(false);
      }

      if (data.type === "closed") {
        onIndexingChange?.(false);
      }
    };
  }, [onIndexingChange, onIndexingComplete]);

  useEffect(() => {
    connectStream();
    return () => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [connectStream]);

  const visible = open;
  if (!visible || typeof document === "undefined") return null;

  const phaseLabel =
    phase === "clearing"
      ? "A limpar catálogo…"
      : phase === "purge"
      ? "A purgar base de dados…"
      : phase === "csv-cache"
      ? "A obter ficheiro CSV do fornecedor (OcioStock)…"
      : phase === "streaming"
      ? "A ler e indexar produtos do CSV…"
      : phase === "done"
      ? "Concluído"
      : phase === "error"
      ? "Erro na indexação"
      : indexing
      ? "A indexar…"
      : "Em espera";

  return createPortal(
    <div
      role="complementary"
      aria-label="Radar de indexação"
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: PANEL_WIDTH,
        maxWidth: "90vw",
        zIndex: 999999,
        display: "flex",
        flexDirection: "column",
        background: "#ffffff",
        borderLeft: "1px solid #e3e3e3",
        boxShadow: "-4px 0 24px rgba(0, 0, 0, 0.15)",
        boxSizing: "border-box",
      }}
    >
      <Box padding="400" borderBlockEndWidth="025" borderColor="border">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">
            Radar de indexação
          </Text>
          <InlineStack gap="200" blockAlign="center">
            {indexing && <span className="alterpop-indexing-dot" aria-hidden />}
            <Text as="span" variant="bodySm" tone={indexing ? "caution" : connected ? "success" : "subdued"}>
              {phaseLabel}
            </Text>
            {indexing && onPauseIndexing && (
              <Button size="slim" tone="critical" onClick={onPauseIndexing}>
                ⏸️ Pausar
              </Button>
            )}
            <Button variant="plain" onClick={onClose}>
              Fechar
            </Button>
          </InlineStack>
        </InlineStack>
      </Box>

      <div style={{ flex: 1, overflowY: "auto", padding: "var(--p-space-400)" }}>
        <BlockStack gap="400">
          <BlockStack gap="150">
            <Text as="p" tone="subdued" variant="bodySm">
              {`${indexed.toLocaleString("pt-PT")} indexados · ${scanned.toLocaleString("pt-PT")} linhas lidas`}
            </Text>
            {onReindexCatalog && (
              <Button
                size="slim"
                onClick={onReindexCatalog}
                loading={indexing}
                disabled={indexing}
              >
                {indexing ? "A re-indexar catálogo…" : "⚡ Recomeçar Re-indexação"}
              </Button>
            )}
          </BlockStack>

          {phase === "done" && auditReport && <IndexingAuditReport audit={auditReport} />}

          <BlockStack gap="200">
            <Text as="p" variant="headingSm">
              Últimos {MAX_ITEMS} produtos
            </Text>
            {items.length === 0 ? (
              <Text as="p" tone="subdued">
                {indexing ? "A aguardar primeiros produtos…" : "Sem actividade recente."}
              </Text>
            ) : (
              items.map((p) => (
                <InlineStack key={p.sku} gap="300" blockAlign="center" wrap={false}>
                  <CatalogProductThumbnail imageUrl={p.imageUrl} title={p.title} size={50} />
                  <BlockStack gap="050">
                    <Text as="span" variant="bodyMd" fontWeight="semibold" truncate>
                      {p.title}
                    </Text>
                    <Text as="span" tone="subdued" variant="bodySm">
                      {`SKU ${p.sku}${p.vendor ? ` · ${p.vendor}` : ""}`}
                    </Text>
                  </BlockStack>
                </InlineStack>
              ))
            )}
          </BlockStack>
        </BlockStack>
      </div>
    </div>,
    document.body
  );
}

export const INDEXING_RADAR_PANEL_WIDTH = PANEL_WIDTH;
