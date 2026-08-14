import { useEffect, useRef } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { markImportJobNotified } from "../utils/importJobNotify.js";

/**
 * Polling de /api/import/status/:jobId com toast App Bridge (equivalente Polaris em embedded apps).
 * Toast só dispara com o separador visível e o componente montado (app aberta).
 *
 * @param {{
 *   jobId: string | null,
 *   jobStatus: object | null,
 *   setJobStatus: (s: object) => void,
 *   onTerminal?: (status: object) => void,
 *   pollMs?: number,
 * }} params
 */
export function useImportJobPolling({
  jobId,
  jobStatus,
  setJobStatus,
  onTerminal,
  pollMs = 2000,
}) {
  const shopify = useAppBridge();
  const notifiedKeyRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!jobId) return;
    if (jobStatus?.state === "completed" || jobStatus?.state === "failed") return;

    let cancelled = false;

    const notifyTerminal = (data) => {
      const key = `${data.jobId}:${data.state}`;
      if (notifiedKeyRef.current === key) return;
      notifiedKeyRef.current = key;

      if (
        typeof document !== "undefined" &&
        document.visibilityState === "visible" &&
        mountedRef.current
      ) {
        if (data.state === "completed") {
          const n = data.summary?.metrics?.totalRows ?? data.processedRows;
          shopify.toast.show(
            n != null
              ? `Importação concluída (${n} SKUs processados)`
              : "Importação concluída com sucesso"
          );
        } else if (data.state === "failed") {
          shopify.toast.show(data.error || "Importação falhou", { isError: true });
        }
        markImportJobNotified(data.jobId);
      }

      onTerminal?.(data);
    };

    const notifySessionExpired = () => {
      const key = `${jobId}:session_expired`;
      if (notifiedKeyRef.current === key) return;
      notifiedKeyRef.current = key;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "visible" &&
        mountedRef.current
      ) {
        shopify.toast.show(
          "A sessão expirou — a importação continua a correr no servidor, mas esta página parou de a acompanhar. Atualiza a página para veres o progresso atual.",
          { isError: true }
        );
      }
    };

    let timer;

    const poll = async () => {
      try {
        const res = await fetch(`/api/import/status/${encodeURIComponent(jobId)}`);

        // 401/403 = sessão embutida expirou. O import corre no servidor independente
        // desta aba — isto só significa que a UI parou de o conseguir consultar.
        // Sem isto, o fetch falhava a ler JSON, caía no catch e ficava a repetir a
        // tentativa para sempre, em silêncio (parecia que a importação "morreu").
        // Pára de sondar — insistir contra uma sessão morta não a vai reviver.
        if (res.status === 401 || res.status === 403) {
          if (!cancelled && mountedRef.current) notifySessionExpired();
          clearInterval(timer);
          return;
        }

        const data = await res.json();
        if (cancelled || !mountedRef.current || !data?.ok) return;

        setJobStatus(data);

        if (data.state === "completed" || data.state === "failed") {
          notifyTerminal(data);
        }
      } catch {
        /* rede momentaneamente em baixo — tenta de novo no próximo intervalo */
      }
    };

    poll();
    timer = setInterval(poll, pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [jobId, jobStatus?.state, setJobStatus, onTerminal, pollMs, shopify]);
}
