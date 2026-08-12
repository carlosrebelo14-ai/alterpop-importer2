import { useEffect, useState } from "react";
import { Banner, Text } from "@shopify/polaris";

/** Item 16 do roadmap — resumo da última corrida do relógio/sync em massa. */
export function LastSyncRunBanner() {
  const [job, setJob] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/sync/jobs?limit=1", { credentials: "same-origin" });
        const data = await res.json();
        if (!cancelled && data?.ok) setJob(data.jobs?.[0] || null);
      } catch {
        if (!cancelled) setJob(null);
      }
    }
    load();
    const timer = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!job) return null;

  const tone = job.status === "failed" ? "critical" : job.failed > 0 ? "warning" : "success";
  const when = new Date(job.startedAt).toLocaleString("pt-PT");

  return (
    <Banner tone={tone}>
      <Text as="p">
        Última corrida ({when}
        {job.status === "running" ? ", em curso" : ""}): {job.succeeded} sucesso, {job.failed} falha(s)
        {job.received > job.succeeded + job.failed
          ? ` (${job.received - job.succeeded - job.failed} ainda por processar)`
          : ""}
      </Text>
    </Banner>
  );
}
