import { useEffect, useState } from "react";

/**
 * @param {unknown} value
 */
function stableKey(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * @template T
 * @param {T} value
 * @param {number} [delayMs]
 * @returns {T}
 */
export function useDebouncedValue(value, delayMs = 350) {
  const [debounced, setDebounced] = useState(value);
  const key = stableKey(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [key, delayMs, value]);

  return debounced;
}
