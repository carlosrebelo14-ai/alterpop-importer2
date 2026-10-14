import { useCallback, useEffect, useState } from "react";
import { BlockStack, Banner, Button, Checkbox, InlineStack, Modal, Text, Badge, ChoiceList, Tooltip } from "@shopify/polaris";
import { BulkActionConfirm, isBulkConfirmed } from "./BulkActionConfirm.jsx";
import { formatEur } from "../../lib/importer/catalog/categoryLabel.js";

/**
 * "Aplicar aos publicados": mudar a margem nunca mexe na loja; esta ação separada atualiza
 * os preços dos produtos já publicados, com pré-visualização e confirmação.
 * Âmbito por omissão: todos os publicados com a regra desatualizada; limitado: os do filtro
 * atual do painel. O preço da loja é lido da Shopify no momento da pré-visualização.
 * Servidor: app/routes/api.curation.reprice-published.jsx.
 *
 * Regra de preço (Decisão 31): com PRICE_MODE desligada o botão extra "Pré-visualizar regra
 * NET" mostra os preços NET (só leitura; o servidor recusa executar uma regra que não é a
 * sua). Produtos com preço manual (override da curadoria) ficam de fora, salvo a opção
 * "Incluir preços manuais".
 */
const THRESHOLD_FALLBACK = 50;
const fmtPct = (n) => `${n > 0 ? "+" : ""}${(Math.round(n * 10) / 10).toLocaleString("pt-PT")} %`;
const fmtEurSigned = (n) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${formatEur(Math.abs(n))}`;

async function post(body) {
  const res = await fetch("/api/curation/reprice-published", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ ok: false, error: "Resposta inválida do servidor" }));
  return data;
}

const th = { textAlign: "right", padding: "4px 8px", fontWeight: 600, whiteSpace: "nowrap" };
const td = { textAlign: "right", padding: "6px 8px", whiteSpace: "nowrap", verticalAlign: "top" };
const tdL = { ...td, textAlign: "left", whiteSpace: "normal" };

export function RepricePublishedButton({ filters, filterSummary, refreshKey, onApplied }) {
  const [summary, setSummary] = useState(null); // { published, outdated } | { error }
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState("rule");
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [typed, setTyped] = useState("");
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState(null);
  const [previewRule, setPreviewRule] = useState(null); // null = regra do servidor; "NET" = só pré-visualização
  const [includeManual, setIncludeManual] = useState(false);

  // Quantos publicados têm a regra desatualizada → ativa o botão.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/curation/reprice-published", { credentials: "same-origin" });
        const data = await res.json();
        if (cancelled) return;
        setSummary(data.ok ? { published: data.published, outdated: data.outdated, rule: data.rule } : { error: data.error || "Erro" });
      } catch (err) {
        if (!cancelled) setSummary({ error: err?.message || "Falha de rede" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const loadPreview = useCallback(
    async (m, rule = previewRule, manual = includeManual) => {
      setLoading(true);
      setError(null);
      setPreview(null);
      setTyped("");
      const data = await post({ action: "preview", mode: m, filters, rule: rule || undefined, includeManual: manual });
      setLoading(false);
      if (!data.ok) setError(data.error || "Erro na pré-visualização");
      else setPreview(data);
    },
    [filters, previewRule, includeManual]
  );

  const openModal = useCallback(
    (rule = null) => {
      setOpen(true);
      setResult(null);
      setMode("rule");
      setPreviewRule(rule);
      loadPreview("rule", rule, includeManual);
    },
    [loadPreview, includeManual]
  );

  const close = useCallback(() => {
    setOpen(false);
    setPreview(null);
    setResult(null);
    setError(null);
  }, []);

  const scope = preview ? preview.rows.length : 0;
  const threshold = preview?.confirmThreshold ?? THRESHOLD_FALLBACK;
  const actionable = preview ? preview.totals.counts.update + preview.totals.counts.notFound : 0;
  const confirmed = isBulkConfirmed(scope, typed, threshold);
  // Pré-visualização de uma regra que não é a do servidor: nunca se executa daqui.
  const previewOnly = Boolean(preview && preview.rule !== preview.serverRule);

  const execute = useCallback(async () => {
    setExecuting(true);
    setError(null);
    const data = await post({ action: "execute", mode, filters, confirmCount: scope, rule: preview?.rule, includeManual });
    setExecuting(false);
    if (!data.ok) {
      setError(data.error || "Erro ao atualizar preços");
      return;
    }
    setResult(data);
    onApplied?.(`Publicados: ${data.updated} atualizado(s), ${data.failed} falhado(s), ${data.ignored} ignorado(s).`);
  }, [mode, filters, scope, onApplied, preview?.rule, includeManual]);

  const ex = preview ? preview.rows.filter((r) => r.category === "ignored" || r.category === "failed" || r.category === "notFound") : [];
  const updates = preview ? preview.rows.filter((r) => r.category === "update") : [];
  const sample = preview ? preview.rows.slice(0, 5) : [];
  // Fora por preço manual: mantêm o preço da loja; mostra-se o que a regra proporia, só para decidir.
  const manualRows = preview ? preview.rows.filter((r) => r.category === "ignored" && (r.ignoreCode === "manualOverride" || r.ignoreCode === "manualDetected")) : [];
  const otherEx = ex.filter((r) => !manualRows.includes(r));

  const disabled = !summary || summary.error || !(summary.outdated > 0);
  const tip = !summary
    ? "A ler os preços da loja…"
    : summary.error
      ? `Não foi possível ler a loja: ${summary.error}`
      : summary.outdated > 0
        ? `${summary.outdated} publicado(s) com o preço da loja diferente da regra`
        : "Todos os publicados estão conformes com a regra";

  return (
    <>
      <Tooltip content={tip}>
        <Button size="slim" disabled={disabled} onClick={() => openModal(null)}>
          {summary?.outdated > 0 ? `Aplicar aos publicados (${summary.outdated})` : "Aplicar aos publicados"}
        </Button>
      </Tooltip>
      {summary?.rule === "LEGACY" && (
        <Tooltip content="Mostra os preços que a regra NET (sem IVA) daria, só em leitura. Não liga a regra nem escreve na loja.">
          <Button size="slim" onClick={() => openModal("NET")}>
            Pré-visualizar regra NET
          </Button>
        </Tooltip>
      )}

      {open && (
        <Modal
          open
          size="large"
          onClose={close}
          title="Aplicar a regra aos publicados"
          primaryAction={
            result
              ? { content: "Fechar", onAction: close }
              : {
                  content: preview ? `Atualizar ${preview.totals.counts.update} preço(s)` : "Atualizar",
                  destructive: true,
                  onAction: execute,
                  loading: executing,
                  disabled: !preview || loading || executing || actionable === 0 || !confirmed || previewOnly,
                }
          }
          secondaryActions={result ? [] : [{ content: "Cancelar", onAction: close }]}
        >
          <Modal.Section>
            <BlockStack gap="300">
              {error && <Banner tone="critical">{error}</Banner>}

              {!result && (
                <ChoiceList
                  title="Âmbito"
                  selected={[mode]}
                  onChange={([m]) => {
                    setMode(m);
                    loadPreview(m);
                  }}
                  choices={[
                    { label: "Todos os publicados com regra desatualizada", value: "rule" },
                    { label: "Só os do filtro atual do painel", value: "filter" },
                  ]}
                />
              )}

              {!result && (
                <Checkbox
                  label="Incluir preços manuais"
                  helpText="Produtos com preço fixado na curadoria ficam de fora por omissão. Ao incluí-los, o preço da loja passa ao da regra."
                  checked={includeManual}
                  onChange={(v) => {
                    setIncludeManual(v);
                    loadPreview(mode, previewRule, v);
                  }}
                />
              )}

              {loading && <Text as="p" tone="subdued">A ler os preços da loja…</Text>}

              {previewOnly && !result && (
                <Banner tone="warning">
                  {`Pré-visualização com a regra ${preview.rule} (o servidor está em ${preview.serverRule}). Só leitura: não é possível atualizar preços a partir daqui. Para aplicar a regra ${preview.rule}, liga PRICE_MODE=${preview.rule} depois de configurar os impostos na Shopify.`}
                </Banner>
              )}

              {preview && !result && (
                <>
                  <Banner tone="info">
                    <Text as="p">
                      {preview.mode === "rule"
                        ? `Âmbito: todos os publicados com a regra desatualizada — ${scope} produto(s). `
                        : `Âmbito limitado ao filtro atual: «${filterSummary}» — ${scope} produto(s) publicados${
                            preview.notPublishedInFilter ? ` (${preview.notPublishedInFilter} do filtro não estão publicados)` : ""
                          }. `}
                      Margem global atual: {preview.globalPct} %. Preço na loja lido às {new Date(preview.readAt).toLocaleTimeString("pt-PT")}.
                    </Text>
                  </Banner>

                  <InlineStack gap="300" wrap>
                    <Badge tone="attention">{`${preview.totals.counts.update} a atualizar`}</Badge>
                    <Badge tone="success">{`${preview.totals.ups} sobem`}</Badge>
                    <Badge tone="warning">{`${preview.totals.downs} descem`}</Badge>
                    <Badge>{`Diferença total ${fmtEurSigned(preview.totals.sumDiff)}`}</Badge>
                    <Badge>{`${preview.totals.counts.conforme} já conformes`}</Badge>
                    <Badge tone={preview.totals.manualExcluded ? "attention" : undefined}>{`${preview.totals.manualExcluded ?? 0} fora por preço manual`}</Badge>
                    <Badge>{`${preview.totals.counts.ignored - (preview.totals.manualExcluded ?? 0)} outros ignorados`}</Badge>
                    <Badge>{`${preview.totals.counts.notFound} não encontrados`}</Badge>
                    <Badge tone={preview.totals.counts.failed ? "critical" : undefined}>{`${preview.totals.counts.failed} falhados`}</Badge>
                  </InlineStack>

                  {updates.length > 0 && (
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                        <thead>
                          <tr>
                            <th style={{ ...th, textAlign: "left", minWidth: 170 }}>Produto</th>
                            <th style={th}>Preço na loja</th>
                            <th style={th}>Preço proposto</th>
                            <th style={th}>Diferença</th>
                            <th style={{ ...th, textAlign: "left", minWidth: 190 }}>Motivo</th>
                            <th style={{ ...th, textAlign: "left", whiteSpace: "nowrap" }}>Limite ativo</th>
                          </tr>
                        </thead>
                        <tbody>
                          {updates.map((r) => (
                            <tr key={r.sku} style={{ borderTop: "1px solid var(--p-color-border, #e1e3e5)", verticalAlign: "top" }}>
                              <td style={tdL}>
                                {r.title || r.sku}
                                <div style={{ color: "#6d7175", fontSize: 12 }}>{r.sku}</div>
                              </td>
                              <td style={td}>{formatEur(r.livePrice)}</td>
                              <td style={td}>{formatEur(r.proposed)}</td>
                              <td style={td}>{`${fmtEurSigned(r.diff)} (${fmtPct(r.diffPct)})`}</td>
                              <td style={tdL}>
                                {r.reasons.length ? r.reasons.join("; ") : "—"}
                                {r.manualOverride ? " · preço manual incluído" : ""}
                                {r.marginInferred && r.reasons.some((x) => x.startsWith("margem")) ? " *" : ""}
                              </td>
                              <td style={tdL}>{r.limit}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {updates.some((r) => r.marginInferred && r.reasons.some((x) => x.startsWith("margem"))) && (
                        <Text as="p" variant="bodySm" tone="subdued">
                          * margem de origem estimada pelo preço da loja (a regra sobe em degraus de {preview.rule === "NET" ? "10 cêntimos" : ",50 e ,90"})
                        </Text>
                      )}
                    </div>
                  )}

                  {manualRows.length > 0 && (
                    <BlockStack gap="100">
                      <Text as="h3" variant="headingSm">{`Fora por preço manual (${manualRows.length}): ficam como estão`}</Text>
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                          <thead>
                            <tr>
                              <th style={{ ...th, textAlign: "left", minWidth: 170 }}>Produto</th>
                              <th style={th}>Preço na loja</th>
                              <th style={th}>{`Preço ${preview.rule}`}</th>
                              <th style={th}>Diferença</th>
                            </tr>
                          </thead>
                          <tbody>
                            {manualRows.map((r) => (
                              <tr key={r.sku} style={{ borderTop: "1px solid var(--p-color-border, #e1e3e5)" }}>
                                <td style={tdL}>
                                  {r.title || r.sku}
                                  <div style={{ color: "#6d7175", fontSize: 12 }}>{r.sku}</div>
                                </td>
                                <td style={td}>{formatEur(r.livePrice)}</td>
                                <td style={td}>{formatEur(r.proposed)}</td>
                                <td style={td}>{`${fmtEurSigned(r.diff)} (${fmtPct(r.diffPct)})`}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </BlockStack>
                  )}

                  {otherEx.length > 0 && (
                    <BlockStack gap="100">
                      <Text as="h3" variant="headingSm">{`Excluídos (${otherEx.length})`}</Text>
                      {otherEx.map((r) => (
                        <Text as="p" key={r.sku} variant="bodySm" tone={r.category === "failed" ? "critical" : "subdued"}>
                          {`${r.sku} — ${r.title || ""} · ${r.reason}`}
                        </Text>
                      ))}
                    </BlockStack>
                  )}

                  <BulkActionConfirm
                    scope={scope}
                    threshold={threshold}
                    scopeText={preview.mode === "rule" ? "todos os publicados com regra desatualizada" : `filtro «${filterSummary}»`}
                    sampleSkus={sample.map((r) => r.sku)}
                    typed={typed}
                    onTyped={setTyped}
                  />

                  {actionable === 0 && <Text as="p" tone="subdued">Nada a atualizar neste âmbito.</Text>}
                </>
              )}

              {result && (
                <BlockStack gap="200">
                  <Banner tone={result.failed ? "warning" : "success"}>
                    <Text as="p">{`Âmbito: ${result.scope} produto(s). Atualizados ${result.updated} · já conformes ${result.conformes} · ignorados ${result.ignored} · falhados ${result.failed} · não encontrados ${result.notFound}.`}</Text>
                  </Banner>
                  {result.recordFailures?.length > 0 && (
                    <Banner tone="critical">{`Preço escrito mas última escrita não gravada: ${result.recordFailures.join(", ")}`}</Banner>
                  )}
                  {result.rows.filter((r) => r.outcome !== "updated" && r.outcome !== "conforme").map((r) => (
                    <Text as="p" key={r.sku} variant="bodySm" tone={r.outcome === "failed" ? "critical" : "subdued"}>
                      {`${r.sku} — ${r.outcome === "notFound" ? "não encontrado: voltou a PENDING (apagado no admin)" : r.outcome} · ${r.error || r.reason || ""}`}
                    </Text>
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}
    </>
  );
}
