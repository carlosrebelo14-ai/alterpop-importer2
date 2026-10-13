#!/usr/bin/env bash
# Tarefas de manutenção da app na Fly, chamadas pelo workflow `maintenance` (e pelo `deploy`).
#
#   bash scripts/ci/maintenance.sh <tarefa> <fase>
#
# tarefa  catalog_health | diagnose_theme | diagnose_characters | tags_cleanup | character_pages_sync | db_push
# fase    dry-run  só lê (ou lista o que mudaria)
#         execute  escreve (só tags_cleanup, character_pages_sync e db_push; nas outras é igual ao dry-run)
#
# O repositório é público: logs e resumos só levam CONTAGENS e ESTADOS. A saída bruta da Fly vai para um
# ficheiro temporário e nunca para o log; daí só se extraem números, ids de verificação (V5...) e estados.
# Nunca SKUs, handles, preços, GIDs nem JSON completos. Em falha mostra-se uma causa classificada, não texto.
#
# Comandos fixos neste ficheiro: nada do que vem de fora é executado na Fly. Escreve um resumo em português
# em $GITHUB_STEP_SUMMARY (e o mesmo no log) e sai com o código do comando principal.
#
# catalog_health e db_push esperam por uma indexação a decorrer (a mesma leitura do V16, via
# scripts/maintenance/check-no-indexing.mjs), repetindo de minuto a minuto até 15 min. Se ao fim disso ainda
# houver indexação, ambos falham sem correr (catalog_health: "catálogo a indexar, repetir", código 75).
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
  *) echo "Tarefa desconhecida." >&2; exit 64 ;;
esac
case "$PHASE" in
  dry-run | execute) ;;
  *) echo "Fase desconhecida." >&2; exit 64 ;;
esac

WRITES=false
case "$TASK" in tags_cleanup | character_pages_sync | db_push) WRITES=true ;; esac
EFFECTIVE="$PHASE"
if [ "$WRITES" = false ]; then EFFECTIVE="dry-run"; fi

# remote <comando fixo>: corre na Fly, a partir de /app. A saída vai só para $OUT, nunca para o log.
remote() {
  "$FLYCTL" ssh console -a "$APP" -C "sh -lc 'cd /app && $1'" >>"$OUT" 2>&1
}

# probe_indexing: 0 sem indexação, 1 a decorrer, 2 não consegui ler o estado.
probe_indexing() {
  local b64 out rc
  b64="$(base64 -w0 "$ROOT/scripts/maintenance/check-no-indexing.mjs")"
  out="$("$FLYCTL" ssh console -a "$APP" -C "sh -lc 'cd /app && echo $b64 | base64 -d | node --input-type=module -'" 2>&1)"
  rc=$?
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
    echo "[manutenção] indexação a decorrer (tentativa $i de $WAIT_MAX_ATTEMPTS)"
    if [ "$i" -lt "$WAIT_MAX_ATTEMPTS" ]; then sleep "$WAIT_STEP"; fi
  done
  WAITED_MIN=$((WAIT_MAX_ATTEMPTS * WAIT_STEP / 60))
  return 1
}

RC=0
KEY=""
RESULT_OVERRIDE=""
case "$TASK" in
  catalog_health)
    DESC="Corre o portão de saúde do catálogo (V3, V5–V19). Só lê."
    wait_for_indexing
    case $? in
      1) NOTE="Catálogo a indexar, repetir. A indexação continuava a decorrer ao fim de ${WAITED_MIN} min: o portão não foi avaliado, porque V5, V6, V7 e V17 medem um catálogo a meio."
         RESULT_OVERRIDE="⏳ Catálogo a indexar, repetir (portão não avaliado)"; RC=75 ;;
      2) NOTE="Não consegui ler o estado da indexação. O portão não correu." ; RC=2 ;;
    esac
    if [ "$RC" -eq 0 ]; then remote "npm run catalog:health"; RC=$?; fi
    ;;
  diagnose_theme)
    DESC="Mostra se read_themes está concedido e o estado do contrato do tema. Só lê. Não liga nem desliga THEME_GUARD."
    remote "node scripts/maintenance/print-access-scopes.js"; RC=$?
    if [ "$RC" -eq 0 ]; then remote "node scripts/maintenance/theme-contract-status.js --summary"; RC=$?; fi
    ;;
  diagnose_characters)
    DESC="Mostra o estado do último ciclo das páginas de Character (só estados e contagens) e o dry-run do character-pages-sync. Só lê."
    remote "node scripts/maintenance/character-cycle-summary.js"; RC=$?
    if [ "$RC" -eq 0 ]; then remote "node scripts/catalog/character-pages-sync.js"; RC=$?; fi
    ;;
  tags_cleanup)
    if [ "$EFFECTIVE" = "execute" ]; then
      DESC="Remove da loja as tags fora da lista permitida (V18), com tagsRemove. Escreve na loja."
      remote "node scripts/catalog/tags-cleanup.js --execute"; RC=$?
    else
      DESC="Conta as tags que a limpeza V18 removeria. Não escreve na loja."
      remote "node scripts/catalog/tags-cleanup.js"; RC=$?
    fi
    ;;
  character_pages_sync)
    if [ "$EFFECTIVE" = "execute" ]; then
      DESC="Cria, atualiza ou põe em rascunho as páginas de Character e escreve alterpop.character nos produtos. Escreve na loja."
      remote "node scripts/catalog/character-pages-sync.js --execute"; RC=$?
    else
      DESC="Conta as ações previstas para as páginas de Character. Não escreve na loja."
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
        NOTE="Indexação ainda a decorrer ao fim de ${WAITED_MIN} min. O db:push não correu (Decisão 28): repetir."; RC=1
      else
        NOTE="Não consegui ler o estado da indexação. O db:push não correu."; RC=2
      fi
    else
      DESC="Conta as alterações que o db:push aplicaria, sem as aplicar. Só lê."
      if [ "$WRC" -eq 1 ]; then NOTE="Há uma indexação a decorrer: o db:push real esperaria por ela."; fi
      if [ "$WRC" -eq 2 ]; then NOTE="Não consegui ler o estado da indexação."; fi
      remote "npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script --exit-code"; RC=$?
      if [ "$RC" -eq 2 ]; then DIFF=true; RC=0; else DIFF=false; fi
    fi
    ;;
esac

# ── resumo em português, só contagens e estados ───────────────────────
CLEAN="$(sed 's/\x1b\[[0-9;]*m//g' "$OUT")"
if [ -n "$RESULT_OVERRIDE" ]; then RESULT="$RESULT_OVERRIDE"
elif [ "$RC" -eq 0 ]; then RESULT="✅ Concluída sem erros"
else RESULT="❌ Falhou (código $RC)"; fi
if [ "$WRITES" = true ] && [ "$EFFECTIVE" = "dry-run" ]; then MODE_PT="dry-run (não escreve)"; elif [ "$WRITES" = true ]; then MODE_PT="execute (escreve)"; else MODE_PT="só leitura"; fi

count() { echo "$CLEAN" | grep -cE "$1" || true; }
first_num() { echo "$CLEAN" | grep -E "$1" | head -1 | grep -oE "$2" | head -1; }

bullets=""
case "$TASK" in
  catalog_health)
    ok=$(count '^  ✓') ; bad=$(count '^  ✗') ; warn=$(count '^  !')
    bullets="- Verificações: **$ok** verdes, **$bad** vermelhas, **$warn** avisos."
    if [ "$bad" -gt 0 ]; then bullets="$bullets"$'\n'"- Vermelhas: $(echo "$CLEAN" | grep '^  ✗' | sed -E 's/^  ✗ +([A-Za-z0-9]+).*/\1/' | paste -sd, - | sed 's/,/, /g')"; fi
    if [ "$warn" -gt 0 ]; then bullets="$bullets"$'\n'"- Avisos: $(echo "$CLEAN" | grep '^  !' | sed -E 's/^  ! +([A-Za-z0-9]+).*/\1/' | paste -sd, - | sed 's/,/, /g')"; fi
    if [ "$RC" -eq 75 ] || [ "$RC" -eq 2 ]; then bullets=""; KEY="não avaliado"; else KEY="$ok verdes, $bad vermelhas, $warn avisos"; fi
    ;;
  diagnose_theme)
    total=$(first_num 'scope\(s\) concedido' '[0-9]+')
    tl="$(echo "$CLEAN" | grep -E '^\[print-access-scopes\] read_themes:' | head -1 | sed -E 's/.*read_themes: *//')"
    json="$(echo "$CLEAN" | grep -E '^\{.*"enforced"' | tail -1)"
    bullets="- Scopes concedidos: **${total:-?}**; read_themes: **${tl:-sem leitura}**."
    if [ -z "$json" ]; then
      # Código antigo na Fly (sem --summary): só estados simples, nunca o JSON.
      en="$(echo "$CLEAN" | grep -oE '"enforced": *(true|false)' | head -1 | sed -E 's/"enforced": */enforced = /')"
      st="$(echo "$CLEAN" | grep -oE '"status": *"[a-z_]+"' | head -1 | sed -E 's/"status": *"([a-z_]+)"/status = \1/')"
      if [ -n "$en$st" ]; then bullets="$bullets"$'\n'"- Contrato do tema: ${en:-?}, ${st:-?} (a Fly ainda não tem --summary: contagens de bloqueios e avisos só depois do próximo deploy)."; fi
    fi
    if [ -n "$json" ]; then
      bullets="$bullets"$'\n'"- Contrato do tema: $(echo "$json" | grep -oE '"(enforced|status|blocking|warnings|erro|ok)":("[^"]*"|[0-9a-z]+)' | sed 's/"//g; s/:/ = /' | paste -sd, - | sed 's/,/, /g')"
    fi
    KEY="read_themes ${tl:-?}"
    ;;
  diagnose_characters)
    cyc="$(echo "$CLEAN" | grep -E '^\{' | head -1)"
    bullets="- Último ciclo: $(echo "$cyc" | grep -oE '"[A-Za-z_]+":("[^"]*"|[0-9a-z]+)' | sed 's/"//g; s/:/ = /' | paste -sd, - | sed 's/,/, /g')"
    cr=$(count '^\s+create\s'); up=$(count '^\s+update\s'); ra=$(count '^\s+reactivate\s'); sd=$(count '^\s+set-draft\s'); er=$(count '^\s+error\s')
    bullets="$bullets"$'\n'"- Dry-run: $cr criar, $up atualizar, $ra reativar, $sd rascunho, $er com erro."
    KEY="$((cr + up + ra + sd)) alterações previstas"
    ;;
  tags_cleanup)
    lidos=$(first_num 'produtos lidos' '[0-9]+'); limpar=$(echo "$CLEAN" | grep -E 'produtos lidos' | head -1 | grep -oE 'a limpar: [0-9]+ \([0-9]+' | grep -oE '[0-9]+' | paste -sd, -)
    locked=$(echo "$CLEAN" | grep -E 'produtos lidos' | head -1 | grep -oE 'sync_locked de fora: [0-9]+' | grep -oE '[0-9]+')
    bullets="- Produtos lidos: **${lidos:-?}**; a limpar (produtos, tags): **${limpar:-?}**; sync_locked de fora: **${locked:-?}**."
    tg="$(echo "$CLEAN" | grep -E '^ +[0-9]+  ' | sed -E 's/^ +([0-9]+)  (.*)$/\2: \1/' | paste -sd';' - | sed 's/;/; /g')"
    if [ -n "$tg" ]; then bullets="$bullets"$'\n'"- Produtos por tag: $tg."; fi
    rel="$(echo "$CLEAN" | grep -E 'releitura' | head -1 | grep -oE 'sem contar sync_locked excluídos\): [0-9]+' | grep -oE '[0-9]+$')"
    if [ -n "$rel" ]; then bullets="$bullets"$'\n'"- Releitura depois da escrita: **$rel** produto(s) ainda com tags fora da lista."; fi
    KEY="lidos ${lidos:-?}, a limpar ${limpar:-?}"
    ;;
  character_pages_sync)
    cr=$(count '^\s+create\s'); up=$(count '^\s+update\s'); ra=$(count '^\s+reactivate\s'); sd=$(count '^\s+set-draft\s'); er=$(count '^\s+error\s')
    bullets="- Ações: $cr criar, $up atualizar, $ra reativar, $sd rascunho, $er com erro."
    pw=$(first_num 'alterpop.character escrito em' '[0-9]+'); cw=$(first_num 'alterpop.characters escrito em' '[0-9]+')
    if [ -n "$pw" ] || [ -n "$cw" ]; then bullets="$bullets"$'\n'"- Escritos: ${pw:-0} produto(s), ${cw:-0} coleção(ões)."; fi
    KEY="$((cr + up + ra + sd)) ações"
    ;;
  db_push)
    if [ "$EFFECTIVE" = "dry-run" ]; then
      if [ "${DIFF:-false}" = true ]; then
        ct=$(count '^CREATE TABLE'); at=$(count '^ALTER TABLE'); ci=$(count '^CREATE (UNIQUE )?INDEX'); dr=$(count '^DROP ')
        bullets="- O esquema da base **difere** do Prisma: $ct tabelas a criar, $at alterações de tabela, $ci índices a criar, $dr remoções (DROP)."
        if [ "$dr" -gt 0 ]; then bullets="$bullets"$'\n'"- ⚠️ Há remoções: o db:push real recusaria perda de dados."; fi
        KEY="há alterações"
      else
        bullets="- Sem alterações: a base já está igual ao esquema."; KEY="sem alterações"
      fi
    fi
    ;;
esac

# Em falha, só uma causa classificada (a saída bruta não é publicada).
CAUSE=""
if [ "$RC" -ne 0 ] && [ "$RC" -ne 75 ]; then
  if echo "$CLEAN" | grep -qiE 'cannot find module|MODULE_NOT_FOUND'; then CAUSE="o código na Fly ainda não tem este script: falta fazer deploy."
  elif echo "$CLEAN" | grep -qiE 'unauthorized|not authorized|token|forbidden|401|403'; then CAUSE="autorização da Fly ou da Shopify recusada."
  elif echo "$CLEAN" | grep -qiE 'connect|timeout|timed out|no such host|dial|ssh'; then CAUSE="não consegui ligar à Fly."
  elif echo "$CLEAN" | grep -qiE 'access scope|required access|read_themes|permission'; then CAUSE="falta uma permissão (scope) na Shopify."
  elif echo "$CLEAN" | grep -qiE 'recus|fatal'; then CAUSE="o próprio script recusou correr (guarda de segurança)."
  else CAUSE="erro não classificado."; fi
fi

SUMMARY_MD="$(
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
  if [ -n "$CAUSE" ]; then echo; echo "**Causa provável:** $CAUSE O detalhe não é publicado (repositório público); consulta os logs da app na Fly."; fi
  echo
  echo "_Este resumo só tem contagens e estados: sem SKUs, handles, preços, GIDs nem JSON completos._"
)"
echo "$SUMMARY_MD" >>"$SUMMARY"
echo "$SUMMARY_MD"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "result=$RESULT" >>"$GITHUB_OUTPUT"
  echo "key=$(echo "$KEY" | head -1)" >>"$GITHUB_OUTPUT"
fi
rm -f "$OUT"
exit "$RC"
