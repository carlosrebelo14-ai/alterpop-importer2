/**
 * Métricas de import — apenas web components Shopify (sem HTML aninhado no SSR).
 * @param {{
 *   metrics?: object,
 *   summary?: object,
 *   status?: object,
 *   jobId?: string,
 *   dryRunEnv?: boolean,
 * }} props
 */
export function ImportJobMetrics({
  metrics: metricsProp,
  summary,
  status,
  jobId: jobIdProp,
  dryRunEnv,
}) {
  try {
    return <ImportJobMetricsInner
      metricsProp={metricsProp}
      summary={summary}
      status={status}
      jobIdProp={jobIdProp}
      dryRunEnv={dryRunEnv}
    />;
  } catch {
    return (
      <s-paragraph>Não foi possível mostrar as métricas deste job.</s-paragraph>
    );
  }
}

function ImportJobMetricsInner({
  metricsProp,
  summary,
  status,
  jobIdProp,
  dryRunEnv,
}) {
  const safeStatus = status && typeof status === "object" ? status : {};
  const safeSummary = summary && typeof summary === "object" ? summary : null;

  const metricsRaw = metricsProp ?? safeSummary?.metrics;
  const metrics =
    metricsRaw && typeof metricsRaw === "object" && !Array.isArray(metricsRaw)
      ? metricsRaw
      : null;

  const jobId = String(jobIdProp ?? safeSummary?.jobId ?? safeStatus.jobId ?? "-");
  const error = safeStatus.error != null ? String(safeStatus.error) : null;
  const state = safeStatus.state ?? safeStatus.status ?? null;

  const processed = toNumber(safeStatus.processedRows);
  const total = toNumber(safeStatus.totalRows);
  const progressPercent =
    safeStatus.progressPercent != null && safeStatus.progressPercent !== ""
      ? toNumber(safeStatus.progressPercent)
      : null;
  const currentSku = formatText(safeStatus.currentSku);

  const showProgress =
    state === "queued" ||
    state === "running" ||
    safeStatus.processedRows != null ||
    safeStatus.totalRows != null ||
    safeStatus.progressPercent != null;

  const curation = metrics?.curationByReason;
  const reasons =
    curation && typeof curation === "object" && !Array.isArray(curation)
      ? Object.entries(curation).sort((a, b) => toNumber(b[1]) - toNumber(a[1]))
      : [];

  if (!metrics && !error && !showProgress) {
    return null;
  }

  const streamRows = toNumber(metrics?.streamRowsRead ?? metrics?.totalRows);
  const validationSkipped = toNumber(metrics?.validationSkipped);
  const failed = toNumber(metrics?.failed);
  const productsCreated = toNumber(metrics?.productsCreated);
  const productsUpdated = toNumber(metrics?.productsUpdated);
  const imagesAttached = toNumber(metrics?.imagesAttached);
  const pricesUpdated = toNumber(metrics?.pricesUpdated);
  const productsActive = toNumber(metrics?.productsActive);
  const curatedDrafts = toNumber(metrics?.curatedDrafts);

  return (
    <s-stack direction="block" gap="base">
      {error ? <s-paragraph>{`Erro: ${error}`}</s-paragraph> : null}

      {showProgress ? (
        <s-paragraph>
          {`Progresso: ${
            progressPercent != null ? `${Math.round(progressPercent)}%` : "-"
          } · ${processed}/${total > 0 ? total : "-"} SKUs · SKU actual: ${currentSku}`}
        </s-paragraph>
      ) : null}

      {metrics ? (
        <s-stack direction="block" gap="base">
          <s-paragraph>
            {`Stream: ${streamRows} SKUs na fila · validação ignorada ${validationSkipped} · falhas ${failed}`}
          </s-paragraph>
          <s-paragraph>
            {`Produtos: +${productsCreated} criados · ~${productsUpdated} actualizados · imagens ${imagesAttached} · preços ${pricesUpdated}`}
          </s-paragraph>
          <s-paragraph>
            {`Curadoria: ACTIVE ${productsActive} · DRAFT ${curatedDrafts}`}
          </s-paragraph>
          {reasons.map(([reason, count]) => (
            <s-paragraph key={String(reason)}>
              {`Motivo ${String(reason)}: ${toNumber(count)}`}
            </s-paragraph>
          ))}
          {jobId !== "-" ? (
            <s-paragraph>
              {`Ficheiros em results/${jobId}/ (summary.json, curated-drafts.json, curation-summary.json)`}
            </s-paragraph>
          ) : null}
        </s-stack>
      ) : null}

      {dryRunEnv ? (
        <s-paragraph>Modo DRY_RUN activo no servidor.</s-paragraph>
      ) : null}
    </s-stack>
  );
}

/** @param {unknown} value @param {number} [fallback] */
function toNumber(value, fallback = 0) {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** @param {unknown} value */
function formatText(value) {
  if (value == null || value === "") return "-";
  return String(value);
}
