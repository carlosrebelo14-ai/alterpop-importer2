/**
 * Tabela de histórico agregado a partir de execution-history.log.
 * @param {{ jobs: Array<{ jobId: string, date: string, skuCount: number, state?: string, hasSummary?: boolean }> }} props
 */
export function ImportHistoryTable({ jobs = [] }) {
  if (!jobs.length) {
    return (
      <s-paragraph>
        Ainda não há importações registadas. O histórico aparece após a primeira execução.
      </s-paragraph>
    );
  }

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--p-color-border)" }}>
            <th style={{ padding: "8px 12px" }}>Data</th>
            <th style={{ padding: "8px 12px" }}>ID do job</th>
            <th style={{ padding: "8px 12px" }}>SKUs processados</th>
            <th style={{ padding: "8px 12px" }}>Estado</th>
            <th style={{ padding: "8px 12px" }}>Resumo</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.jobId} style={{ borderBottom: "1px solid var(--p-color-border-subdued)" }}>
              <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                {formatDate(job.date)}
              </td>
              <td style={{ padding: "8px 12px" }}>
                <code>{job.jobId}</code>
              </td>
              <td style={{ padding: "8px 12px" }}>{job.skuCount ?? 0}</td>
              <td style={{ padding: "8px 12px" }}>{stateLabel(job.state)}</td>
              <td style={{ padding: "8px 12px" }}>
                {job.hasSummary ? (
                  <a
                    href={`/api/import/results/${encodeURIComponent(job.jobId)}/summary`}
                    download={`summary-${job.jobId}.json`}
                    style={{ color: "var(--p-color-text-link)" }}
                  >
                    Descarregar summary.json
                  </a>
                ) : (
                  <s-paragraph>—</s-paragraph>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </s-box>
  );
}

function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("pt-PT", {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

function stateLabel(state) {
  if (state === "completed") return "Concluído";
  if (state === "failed") return "Falhou";
  return "—";
}
