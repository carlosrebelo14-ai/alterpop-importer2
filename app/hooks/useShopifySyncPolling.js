import { useEffect } from "react";

/**
 * Polling leve quando o modal de publicação não está aberto.
 * @param {{ enabled: boolean, onStatus?: (status: object) => void, pollMs?: number }} params
 */
export function useShopifySyncPolling({ enabled, onStatus, pollMs = 2000 }) {
  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch("/api/shopify-sync", { credentials: "same-origin" });
        const data = await res.json();
        if (cancelled || !data?.ok) return;
        onStatus?.(data.status);
      } catch {
        /* ignore */
      }
    };

    poll();
    const timer = setInterval(poll, pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, onStatus, pollMs]);
}
