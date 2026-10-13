#!/usr/bin/env bash
# Tarefas de manutenção da app na Fly, chamadas pelo workflow `maintenance` (e pelo `deploy`).
#
#   bash scripts/ci/maintenance.sh <tarefa> <fase>
#
# tarefa  catalog_health | diagnose_theme | diagnose_characters | tags_cleanup | character_pages_sync | db_push
# fase    dry-run  só lê (ou lista o que mudaria)
#         execute  escreve (só tags_cleanup, character_pages_sync e db_push; nas outras é igual ao dry-run)
#
# Comandos fixos neste ficheiro: nada do que vem de fora é executado na Fly. Escreve um resumo em
# português em $GITHUB_STEP_SUMMARY e sai com o código do comando principal.
#
# catalog_health e db_push esperam por uma indexação a decorrer (a mesma leitura do V16, via
# scripts/maintenance/check-no-indexing.mjs), repetindo de minuto a minuto até 15 min. Se ao fim disso
# ainda houver indexação, o catalog_health avalia na mesma e avisa que V5, V6, V7 e V17 podem estar errados;
# o db_push execute recusa-se a correr.
#
# Variáveis (testes): FLYCTL, FLY_APP, WAIT_STEP_SECONDS (60), WAIT_MAX_ATTEMPTS (15 min / passo).
set -uo pipefail

TASK="${1:-}"
PHASE="${2:-}"
APP="${FLY_APP:-alterpop-importer-app}"
FLYCTL="${FLYCTL:-flyctl}"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"
WAIT_STEP="${WAIT_STEP_SECONDS:-60}"
WAIT_MAX_ATTEMPTS="${WAIT_MAX_ATTEMPTS:-$((15 * 60 / (WAIT_STEP > 0 ? WAIT_STEP : 60)))}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$(mktemp)"
NOTE=""
WAITED_MIN=0

case "$TASK" in
  catalog_health | diagnose_theme | diagnose_characters | tags_cleanup | character_pages_sync | db_push) ;;
  *) echo "Tarefa desconhecida: '$TASK'" >&2; exit 64 ;;
esac
case "$PHASE" in
  dry-run | execute) ;;
  *) echo "Fase desconhecida: '$PHASE'" >&2; exit 64 ;;
esac

WRITES=false
case "$TASK" in tags_cleanup | character_pages_sync | db_push) WRITES=true ;; esac
EFFECTIVE="$PHASE"
if [ "$WRITES" = false ]; then EFFECTIVE="dry-run"; fi

# remote <comando fixo>: corre na Fly, a partir de /app. Os comandos não levam aspas simples.
remote() {
  "$FLYCTL" ssh console -a "$APP" -C "sh -lc 'cd /app && $1'" 2>&1 | tee -a "$OUT"
  return "${PIPESTATUS[0]}"
}

# probe_indexing: 0 sem indexação, 1 a decorrer, 2 não consegui ler o estado.
probe_indexing() {
  local b64 out rc
  b64="$(base64 -w0 "$ROOT/scripts/maintenance/check-no-indexing.mjs")"
  out="$("$FLYCTL" ssh console -a "$APP" -C "sh -lc 'cd /app && echo $b64 | base64 -d | node --input-type=module -'" 2>&1)"
  rc=$?
  echo "$out" | tee -a "$OUT" >/dev/null
  if [ "$rc" -eq 0 ]; then return 0; fi
  if echo "$out" | grep -q "INDEXAÇÃO A DECORRER"; then return 1; fi
  return 2
}

# wait_for_indexing: 0 livre, 1 ainda a decorrer ao fim do tempo, 2 estado ilegível.
wait_for_indexing() {
  local i rc
  for ((i = 1; i <= WAIT_MAX_ATTEMPTS; i++)); do
    probe_indexing
    rc=$?
    if [ "$rc" -eq 0 ]; then WAITED_MIN=$(((i - 1) * WAIT_STEP / 60)); return 0; fi
    if [ "$rc" -eq 2 ]; then return 2; fi
    echo "[manutenção] indexação a decorrer (tentativa $i de $WAIT_MAX_ATTEMPTS), a esperar ${WAIT_STEP}s" | tee -a "$OUT"
    if [ "$i" -lt "$WAIT_MAX_ATTEMPTS" ]; then sleep "$WAIT_STEP"; fi
  done
  WAITED_MIN=$((WAIT_MAX_ATTEMPTS * WAIT_STEP / 60))
  return 1
}

RC=0
KEY=""
case "$TASK" in
  catalog_health)
    DESC="Corre o portão de saúde do catálogo (V3, V5–V19). Só lê."
    wait_for_indexing
    case $? in
      1) NOTE="A indexação continuava a decorrer ao fim de ${WAITED_MIN} min. O portão correu na mesma, mas V5, V6, V7 e V17 podem estar errados." ;;
      2) NOTE="Não consegui ler o estado da indexação. O portão não correu." ; RC=2 ;;
    esac
    if [ "$RC" -eq 0 ]; then remote "npm run catalog:health"; RC=$?; fi
    ;;
  diagnose_theme)
    DESC="Mostra os scopes concedidos (incluindo read_themes) e o estado do contrato do tema. Só lê. Não liga nem desliga THEME_GUARD."
    remote "node scripts/maintenance/print-access-scopes.js"; RC=$?
    if [ "$RC" -eq 0 ]; then remote "node scripts/maintenance/theme-contract-status.js"; RC=$?; fi
    ;;
  diagnose_characters)
    DESC="Mostra o estado do último ciclo das páginas de Character e o dry-run do character-pages-sync. Só lê."
    remote "if [ -f /app/data/character-pages-cycle-state.json ]; then cat /app/data/character-pages-cycle-state.json; else echo sem-ficheiro-de-estado-do-ciclo; fi"; RC=$?
    if [ "$RC" -eq 0 ]; then remote "node scripts/catalog/character-pages-sync.js"; RC=$?; fi
    ;;
  tags_cleanup)
    if [ "$EFFECTIVE" = "execute" ]; then
      DESC="Remove da loja as tags fora da lista permitida (V18), com tagsRemove. Escreve na loja."
      remote "node scripts/catalog/tags-cleanup.js --execute"; RC=$?
    else
      DESC="Lista as tags que a limpeza V18 removeria. Não escreve na loja."
      remote "node scripts/catalog/tags-cleanup.js"; RC=$?
    fi
    ;;
  character_pages_sync)
    if [ "$EFFECTIVE" = "execute" ]; then
      DESC="Cria, atualiza ou põe em rascunho as páginas de Character e escreve alterpop.character nos produtos. Escreve na loja."
      remote "node scripts/catalog/character-pages-sync.js --execute"; RC=$?
    else
      DESC="Lista as ações previstas para as páginas de Character. Não escreve na loja."
      remote "node scripts/catalog/character-pages-sync.js"; RC=$?
    fi
    ;;
  db_push)
    wait_for_indexing
    WRC=$?
    if [ "$EFFECTIVE" = "execute" ]; then
      DESC="Aplica o esquema Prisma ao SQLite do volume (db:push, sem aceitar perda de dados). Escreve na base de dados."
      if [ "$WRC" -eq 0 ]; then
        remote "npm run db:push"; RC=$?
      elif [ "$WRC" -eq 1 ]; then
        NOTE="Indexação ainda a decorrer ao fim de ${WAITED_MIN} min. O db:push não correu (Decisão 28)."; RC=1
      else
        NOTE="Não consegui ler o estado da indexação. O db:push não correu."; RC=2
      fi
    else
      DESC="Mostra o SQL que o db:push aplicaria, sem o aplicar. Só lê."
      if [ "$WRC" -eq 1 ]; then NOTE="Há uma indexação a decorrer: o db:push real esperaria por ela."; fi
      if [ "$WRC" -eq 2 ]; then NOTE="Não consegui ler o estado da indexação."; fi
      remote "npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script --exit-code"; RC=$?
      if [ "$RC" -eq 2 ]; then DIFF=true; RC=0; else DIFF=false; fi
    fi
    ;;
esac

# ── resumo em português ───────────────────────────────────────────────
CLEAN="$(sed 's/\x1b\[[0-9;]*m//g' "$OUT")"
if [ "$RC" -eq 0 ]; then RESULT="✅ Concluída sem erros"; else RESULT="❌ Falhou (código $RC)"; fi
if [ "$WRITES" = true ] && [ "$EFFECTIVE" = "dry-run" ]; then MODE_PT="dry-run (não escreve)"; elif [ "$WRITES" = true ]; then MODE_PT="execute (escreve)"; else MODE_PT="só leitura"; fi

bullets=""
case "$TASK" in
  catalog_health)
    ok=$(echo "$CLEAN" | grep -c '^  ✓') ; bad=$(echo "$CLEAN" | grep -c '^  ✗') ; warn=$(echo "$CLEAN" | grep -c '^  !')
    bullets="- Verificações: **$ok** verdes, **$bad** vermelhas, **$warn** avisos."
    if [ "$bad" -gt 0 ]; then bullets="$bullets"$'\n'"- Vermelhas:"$'\n'"$(echo "$CLEAN" | grep '^  ✗' | sed 's/^  /  - /')"; fi
    KEY="$ok verdes, $bad vermelhas, $warn avisos"
    ;;
  tags_cleanup)
    KEY="$(echo "$CLEAN" | grep -E 'produtos lidos' | head -1 | sed 's/^ *//')"
    bullets="- ${KEY:-sem linha de resumo (ver a saída)}"
    ;;
  character_pages_sync)
    KEY="$(echo "$CLEAN" | grep -E '^\s+(create|update|reactivate|set-draft|error)\s' | sed 's/^ *//' | head -12)"
    bullets="- Ações:"$'\n'"$(echo "$KEY" | sed 's/^/  - /')"
    KEY="$(echo "$KEY" | wc -l | tr -d ' ') ações"
    ;;
  db_push)
    if [ "$EFFECTIVE" = "dry-run" ]; then
      if [ "${DIFF:-false}" = true ]; then bullets="- O esquema da base **difere** do Prisma: o SQL está na saída."; KEY="há alterações"; else bullets="- Sem alterações: a base já está igual ao esquema."; KEY="sem alterações"; fi
    fi
    ;;
esac

{
  echo "## Manutenção · \`$TASK\` · $MODE_PT"
  echo
  echo "**Resultado:** $RESULT"
  echo
  echo "**O que faz:** $DESC"
  if [ "$WRITES" = false ] && [ "$PHASE" = "execute" ]; then echo; echo "O modo execute não se aplica a esta tarefa: é sempre só leitura."; fi
  if [ "$WAITED_MIN" -gt 0 ]; then echo; echo "**Indexação:** esperei cerca de ${WAITED_MIN} min por uma indexação a decorrer."; fi
  if [ -n "$NOTE" ]; then echo; echo "> ⚠️ $NOTE"; fi
  if [ -n "$KEY" ]; then echo; echo "**Em resumo:** $(echo "$KEY" | head -1)"; fi
  if [ -n "$bullets" ]; then echo; echo "$bullets"; fi
  echo
  echo "<details><summary>Saída (últimas 80 linhas)</summary>"
  echo
  echo '```'
  echo "$CLEAN" | tail -n 80
  echo '```'
  echo
  echo "</details>"
} >>"$SUMMARY"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "result=$RESULT" >>"$GITHUB_OUTPUT"
  echo "key=$(echo "$KEY" | head -1)" >>"$GITHUB_OUTPUT"
fi
rm -f "$OUT"
exit "$RC"
