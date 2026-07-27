#!/usr/bin/env bash
# Reinicia o processo se terminar com erro (dev ou produção local).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CMD="${1:-npm run dev}"
MAX_RESTARTS="${MAX_RESTARTS:-50}"
RESTART_DELAY_SEC="${RESTART_DELAY_SEC:-3}"
count=0

echo "[run-with-restart] Comando: $CMD"
echo "[run-with-restart] Máx. reinícios: $MAX_RESTARTS · pausa: ${RESTART_DELAY_SEC}s"

while [ "$count" -lt "$MAX_RESTARTS" ]; do
  count=$((count + 1))
  echo "[run-with-restart] Arranque #$count — $(date -Iseconds)"

  if bash -lc "$CMD"; then
    echo "[run-with-restart] Processo terminou com código 0 — a sair."
    exit 0
  fi

  code=$?
  echo "[run-with-restart] Processo caiu (exit $code). Reinício em ${RESTART_DELAY_SEC}s…"
  sleep "$RESTART_DELAY_SEC"
done

echo "[run-with-restart] Limite de reinícios atingido."
exit 1
