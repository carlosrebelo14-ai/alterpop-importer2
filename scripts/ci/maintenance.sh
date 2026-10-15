#!/usr/bin/env bash
# Tarefas de manutenção da app na Fly, chamadas pelo workflow `maintenance` (e pelo `deploy`).
#
#   bash scripts/ci/maintenance.sh <tarefa> <fase>
#
# tarefa  catalog_health | diagnose_theme | diagnose_characters | price_check | volume_snapshot | tags_cleanup | character_pages_sync | db_push
#         | db_flag_check | logs_recent | restore_dry_run   (estas três só leem; nenhuma aceita execute)
# db_push recusa-se com a flag DB_DEGRADED presente no volume (Decisão 34), em dry-run e em execute.
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
CAUSE=""
WAITED_MIN=0
DB_BLOCKED=0
FS=""
LOGS="$(mktemp)"
RESTORE_OUT="$(mktemp)"
LOG_SUM=""

case "$TASK" in
  catalog_health | diagnose_theme | diagnose_characters | price_check | volume_snapshot | tags_cleanup | character_pages_sync | db_push | db_flag_check | logs_recent | restore_dry_run) ;;
  *) echo "Tarefa desconhecida." >&2; exit 64 ;;
esac
# As tarefas novas só leem: nenhuma aceita execute, nem como no-op.
case "$TASK" in
  db_flag_check | logs_recent | restore_dry_run)
    if [ "$PHASE" = "execute" ]; then echo "Esta tarefa só lê: não aceita execute." >&2; exit 64; fi ;;
esac
case "$PHASE" in
  dry-run | execute) ;;
  *) echo "Fase desconhecida." >&2; exit 64 ;;
esac

WRITES=false
case "$TASK" in volume_snapshot | tags_cleanup | character_pages_sync | db_push) WRITES=true ;; esac
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

# flag_state: ABSENT | PRESENT | UNKNOWN. Só lê o volume (a flag DB_DEGRADED, Decisão 34). Nunca escreve.
DB_FLAG="/app/data/DB_DEGRADED"
flag_state() {
  local out rc
  out="$("$FLYCTL" ssh console -a "$APP" -C "sh -lc 'if [ -e $DB_FLAG ]; then echo FLAG_PRESENT; else echo FLAG_ABSENT; fi'" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then echo UNKNOWN; return; fi
  if echo "$out" | grep -q "FLAG_PRESENT"; then echo PRESENT
  elif echo "$out" | grep -q "FLAG_ABSENT"; then echo ABSENT
  else echo UNKNOWN; fi
}

# kv <chave>: valor de uma linha CHAVE=valor do resumo de logs (scripts/maintenance/logs-summary.mjs).
kv() { echo "$LOG_SUM" | grep -E "^$1=" | head -1 | cut -d= -f2-; }
# kn <chave>: como kv, mas 0 quando a chave não existe (para comparar com -gt).
kn() { local v; v="$(kv "$1")"; echo "${v:-0}"; }

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
    # Erros de escrita do ciclo sem handles nem GIDs: script só de leitura enviado em base64 (não precisa de deploy).
    EB64="$(base64 -w0 "$ROOT/scripts/maintenance/character-cycle-errors.mjs")"
    if [ "$RC" -eq 0 ]; then remote "echo $EB64 | base64 -d | node --input-type=module -"; RC=$?; fi
    if [ "$RC" -eq 0 ]; then remote "node scripts/catalog/character-pages-sync.js"; RC=$?; fi
    ;;
  price_check)
    DESC="Lê na Shopify se os preços incluem imposto (taxesIncluded) e os preços dos publicados, e compara-os com a regra NET. Só lê. Não muda PRICE_MODE nem a loja."
    remote "node scripts/maintenance/price-check.js"; RC=$?
    ;;
  volume_snapshot)
    # Snapshot do volume da app (cópia do SQLite com PriceHistory e lastPriceWrite) antes de operações grandes.
    # Corre no runner com o flyctl (não por ssh). Nunca imprime ids de volumes nem de snapshots.
    VOL_COUNT=0; SNAP_BEFORE=0; SNAP_AFTER=0
    jcount() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(Array.isArray(j)?j.length:0)}catch{console.log("x")}})'; }
    jfirst() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(Array.isArray(j)&&j[0]?String(j[0].id||""):"")}catch{console.log("")}})'; }
    if [ "$EFFECTIVE" = "execute" ]; then
      DESC="Cria um snapshot do volume da app na Fly (cópia da base de dados). Escreve na Fly (cria um snapshot); não toca na loja nem nos dados."
    else
      DESC="Lê o volume da app e os snapshots existentes. Só lê. O execute cria um snapshot novo."
    fi
    VOLS="$("$FLYCTL" volumes list -a "$APP" --json 2>>"$OUT")"; RC=$?
    if [ "$RC" -eq 0 ]; then
      VOL_COUNT="$(echo "$VOLS" | jcount)"
      if [ "$VOL_COUNT" != "1" ]; then
        NOTE="Esperava exatamente 1 volume e encontrei ${VOL_COUNT}. Não escolho um à sorte: indica qual."; RC=3
      else
        VID="$(echo "$VOLS" | jfirst)"
        SNAP_BEFORE="$("$FLYCTL" volumes snapshots list "$VID" --json 2>>"$OUT" | jcount)"
        if [ "$EFFECTIVE" = "execute" ]; then
          "$FLYCTL" volumes snapshots create "$VID" -a "$APP" >>"$OUT" 2>&1; RC=$?
          if [ "$RC" -eq 0 ]; then SNAP_AFTER="$("$FLYCTL" volumes snapshots list "$VID" --json 2>>"$OUT" | jcount)"; fi
        fi
      fi
    fi
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
  db_flag_check)
    DESC="Lê se a flag DB_DEGRADED existe no volume. Só lê. Não mostra a causa: o repositório é público."
    FS="$(flag_state)"
    case "$FS" in
      ABSENT)  RESULT_OVERRIDE="✅ Flag DB_DEGRADED ausente"; RC=0 ;;
      PRESENT) RESULT_OVERRIDE="⛔ Flag DB_DEGRADED presente"; RC=1
               CAUSE="a flag DB_DEGRADED existe no volume: a app está em modo degradado e a sequência para. A causa fica no volume (ver com fly ssh; não é publicada)." ;;
      *)       RESULT_OVERRIDE="❓ Não consegui ler a flag"; RC=2
               CAUSE="não consegui ler o estado da flag DB_DEGRADED (ssh ou resposta inesperada)." ;;
    esac
    ;;
  logs_recent)
    # flyctl logs (referência oficial): --no-tail devolve o buffer; --json, uma entrada por linha.
    # Não há flag de número de linhas nem de janela temporal: a janela é a que o buffer cobre, e o
    # resumo mostra essa janela. As linhas em bruto ficam no ficheiro temporário e não são publicadas.
    DESC="Conta sinais dos logs recentes da app: modo degradado, escritas recusadas, BD bloqueada, reinícios do worker e início, fim e causa da indexação. Só lê. Não mostra linhas."
    "$FLYCTL" logs -a "$APP" --no-tail --json >"$LOGS" 2>>"$OUT"; RC=$?
    if [ "$RC" -ne 0 ]; then
      CAUSE="não consegui ler os logs da Fly."
    else
      LOG_SUM="$(node "$ROOT/scripts/maintenance/logs-summary.mjs" "$LOGS" 2>>"$OUT")"; RC=$?
      if [ "$RC" -ne 0 ]; then
        CAUSE="não consegui resumir os logs (scripts/maintenance/logs-summary.mjs)."
      elif [ "$(kn DBD)" -gt 0 ] || [ "$(kn MODO_DEGRADADO)" -gt 0 ]; then
        RESULT_OVERRIDE="⛔ Erros de modo degradado nos logs"; RC=1
        CAUSE="há DbDegradedError ou mensagens de modo degradado nos logs recentes: a sequência para."
      elif [ "$(kn REINICIOS)" -gt 0 ] || [ "$(kn DB_LOCKED)" -gt 0 ] || [ "$(kn RECUSAS)" -gt 0 ]; then
        RESULT_OVERRIDE="⚠️ Sinais nos logs (ver contagens)"
      fi
    fi
    ;;
  restore_dry_run)
    DESC="Copia dev.sqlite e o WAL (se existir) do volume para uma pasta temporária do runner e corre o restauro sem --execute sobre a cópia. Só lê: a BD da Fly não é tocada."
    COPY_DIR="$(mktemp -d)"
    "$FLYCTL" ssh sftp get /app/data/dev.sqlite "$COPY_DIR/dev.sqlite" -a "$APP" >>"$OUT" 2>&1; RC=$?
    if [ "$RC" -ne 0 ]; then
      CAUSE="não consegui copiar dev.sqlite do volume (ssh sftp): verificar o token e o acesso ao volume."
    else
      "$FLYCTL" ssh sftp get /app/data/dev.sqlite-wal "$COPY_DIR/dev.sqlite-wal" -a "$APP" >>"$OUT" 2>&1 || true
      DATABASE_URL="file:$COPY_DIR/dev.sqlite" node "$ROOT/scripts/setup/restore-db-degraded.js" >"$RESTORE_OUT" 2>>"$OUT"; RC=$?
      if [ "$RC" -ne 0 ]; then CAUSE="a cópia não passa integrity_check: o restauro real teria de ser feito antes de limpar a flag."; fi
    fi
    rm -rf "$COPY_DIR"
    ;;
  db_push)
    DESC="Aplica o esquema Prisma ao SQLite do volume (db:push, sem aceitar perda de dados). Escreve na base de dados. Recusado enquanto a flag DB_DEGRADED existir."
    FS="$(flag_state)"
    if [ "$FS" = "PRESENT" ]; then
      DB_BLOCKED=1; RESULT_OVERRIDE="⛔ db:push recusado: flag DB_DEGRADED presente"; RC=1
      CAUSE="a flag DB_DEGRADED existe no volume: o db:push recusa-se até a BD ser restaurada (Decisão 34)."
    elif [ "$FS" != "ABSENT" ]; then
      DB_BLOCKED=1; RESULT_OVERRIDE="❓ db:push recusado: não consegui ler a flag"; RC=2
      CAUSE="não consegui ler a flag DB_DEGRADED: o db:push não correu."
    fi
    if [ "$DB_BLOCKED" -eq 0 ]; then
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
    errs="$(echo "$CLEAN" | grep -E '^ERRO: ' | sed 's/^ERRO: /  - /')"
    if [ -n "$errs" ]; then bullets="$bullets"$'\n'"- Erros do último ciclo (sem handles nem GIDs):"$'\n'"$errs"; fi
    bullets="$bullets"$'\n'"- Dry-run: $cr criar, $up atualizar, $ra reativar, $sd rascunho, $er com erro."
    KEY="$((cr + up + ra + sd)) alterações previstas"
    ;;
  price_check)
    pc() { echo "$CLEAN" | grep -E "^PC: $1=" | head -1 | sed -E "s/^PC: $1=//"; }
    rule="$(pc regra_servidor)"; taxes="$(pc impostos_incluidos)"
    if [ -z "$rule" ]; then
      bullets="- Sem leitura: o script não devolveu contagens (código novo ainda sem deploy, ou erro de leitura)."; KEY="sem leitura"
    else
      bullets="- Regra do servidor (PRICE_MODE): **$rule**. Impostos incluídos nos preços (taxesIncluded): **$taxes**."
      case "$rule/$taxes" in
        LEGACY/true) bullets="$bullets"$'\n'"- Estado coerente de **antes** da troca: regra antiga com IVA incluído." ;;
        NET/false)   bullets="$bullets"$'\n'"- Estado coerente de **depois** da troca: preços sem IVA, imposto acrescentado ao pagamento." ;;
        NET/true)    bullets="$bullets"$'\n'"- ⚠️ Estado intermédio: regra NET com impostos incluídos nos preços. Os clientes pagariam sem IVA até virares os impostos para \"não incluídos\"." ;;
        LEGACY/false) bullets="$bullets"$'\n'"- ⚠️ Estado intermédio: regra antiga (já com IVA) com impostos não incluídos. A loja acrescenta IVA por cima (preços 21 % acima do pretendido) até aplicares a regra NET." ;;
      esac
      bullets="$bullets"$'\n'"- Publicados lidos: **$(pc publicados)**; já conformes com a regra NET: **$(pc conformes_net)**; a atualizar: **$(pc a_atualizar)** (sobem $(pc sobem), descem $(pc descem); mediana da diferença $(pc mediana_diff_pct) %)."
      bullets="$bullets"$'\n'"- Diferença por degrau: até 1 %: $(pc banda_ate_1); 1 a 5 %: $(pc banda_1_a_5); 5 a 15 %: $(pc banda_5_a_15); acima de 15 %: $(pc banda_acima_15)."
      bullets="$bullets"$'\n'"- Ficam fora por preço manual: **$(pc fora_preco_manual)** (override da curadoria $(pc manual_override), preço detetado $(pc manual_detetado)). Trancados: $(pc trancados); sem registo da última escrita: $(pc sem_registo); outros ignorados: $(pc outros_ignorados); não encontrados: $(pc nao_encontrados); falhados: $(pc falhados)."
      KEY="regra $rule, impostos incluídos $taxes, $(pc a_atualizar) a atualizar, $(pc fora_preco_manual) fora por preço manual"
    fi
    ;;
  volume_snapshot)
    if [ "$VOL_COUNT" = "1" ]; then
      bullets="- Volumes da app: **1**. Snapshots existentes antes: **$SNAP_BEFORE**."
      if [ "$EFFECTIVE" = "execute" ] && [ "$RC" -eq 0 ]; then
        bullets="$bullets"$'\n'"- Snapshots depois do pedido: **$SNAP_AFTER**. O snapshot pode demorar alguns minutos a ficar disponível; confirma mais tarde com a tarefa volume_snapshot em dry-run."
        KEY="snapshot pedido ($SNAP_BEFORE → $SNAP_AFTER snapshots)"
      else
        KEY="1 volume, $SNAP_BEFORE snapshots"
      fi
    else
      KEY="volumes: $VOL_COUNT"
    fi
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
    if [ "$EFFECTIVE" = "dry-run" ] && [ "$DB_BLOCKED" -eq 0 ]; then
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
  db_flag_check)
    case "$FS" in ABSENT) FS_PT="ausente" ;; PRESENT) FS_PT="presente" ;; *) FS_PT="não lida" ;; esac
    bullets="- Flag DB_DEGRADED: **$FS_PT**."
    KEY="flag $FS_PT"
    ;;
  logs_recent)
    if [ -z "$LOG_SUM" ]; then
      bullets=""; KEY="sem leitura"
    else
      bullets="- Linhas lidas: **$(kn LINHAS)**. Janela coberta pelo que a Fly devolve: de $(kv JANELA_INICIO) a $(kv JANELA_FIM)."
      bullets="$bullets"$'\n'"- DbDegradedError: **$(kn DBD)**. Mensagens de modo degradado: **$(kn MODO_DEGRADADO)**. Escritas recusadas: **$(kn RECUSAS)**, das quais na fila de curadoria: **$(kn RECUSAS_FILA)**. \`database is locked\`: **$(kn DB_LOCKED)**."
      bullets="$bullets"$'\n'"- Indexação: **$(kn INDEX_INICIOS)** início(s), por causa: painel $(kn INDEX_CAUSA_PAINEL), ciclo $(kn INDEX_CAUSA_CICLO), script $(kn INDEX_CAUSA_SCRIPT), não registada $(kn INDEX_CAUSA_DESCONHECIDA). Fins: **$(kn INDEX_CONCLUIDAS)** concluída(s), **$(kn INDEX_FALHADAS)** falhada(s), **$(kn INDEX_PARADAS)** parada(s)."
      bullets="$bullets"$'\n'"- Reinícios do worker (saiu sem concluir): **$(kn REINICIOS)**."
      if [ "$(kv INDEX_ULTIMA_CAUSA)" != "-" ] && [ -n "$(kv INDEX_ULTIMA_CAUSA)" ]; then
        bullets="$bullets"$'\n'"- Último fim de indexação: causa **$(kv INDEX_ULTIMA_CAUSA)**, estado **$(kv INDEX_ULTIMA_ESTADO)**, duração **$(kv INDEX_ULTIMA_DURACAO_S)** s, às $(kv INDEX_ULTIMO_FIM_TS)."
      fi
      if [ "$(kn INDEX_A_DECORRER)" -eq 1 ]; then
        bullets="$bullets"$'\n'"- ⚠️ Indexação a decorrer desde $(kv INDEX_ULTIMO_INICIO_TS) (início sem fim nas linhas lidas)."
      fi
      KEY="$(kn DBD) DbDegradedError, $(kn RECUSAS) recusas, $(kn REINICIOS) reinícios do worker"
    fi
    ;;
  restore_dry_run)
    if grep -q 'integrity_check: ok' "$RESTORE_OUT" 2>/dev/null; then IC="ok"; elif grep -q 'integrity_check:' "$RESTORE_OUT" 2>/dev/null; then IC="falhou"; else IC="não correu"; fi
    bullets="- Cópia de dev.sqlite do volume para o runner (temporária, apagada no fim). integrity_check da cópia: **$IC**. Dry-run: nenhuma flag foi apagada e a BD da Fly não foi tocada."
    KEY="integrity_check da cópia: $IC"
    ;;
esac

# Em falha, só uma causa classificada (a saída bruta não é publicada). CAUSE pode já vir de uma tarefa.
if [ "$RC" -ne 0 ] && [ "$RC" -ne 75 ] && [ -z "$CAUSE" ]; then
  if [ "$TASK" = "catalog_health" ] && [ "$(count '^  [✓✗!] ')" -gt 0 ]; then CAUSE="o portão correu e tem verificações vermelhas (ver a lista acima)."
  elif echo "$CLEAN" | grep -qiE 'cannot find module|MODULE_NOT_FOUND'; then CAUSE="o código na Fly ainda não tem este script: falta fazer deploy."
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
rm -f "$OUT" "$LOGS" "$RESTORE_OUT"
exit "$RC"
