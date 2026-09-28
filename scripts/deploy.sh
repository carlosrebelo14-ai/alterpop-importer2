#!/usr/bin/env bash
# Único caminho de deploy do alterpop-importer-app (decisão 28/09/2026, 14:16).
#
# Incidente de origem (28/09): `flyctl deploy` correu a partir de um `main` local que
# ainda não tinha o merge do PR #81 — a imagem saiu com o código antigo, sem erro
# nenhum. O flyctl empacota o diretório local (COPY . .), não o que está no GitHub.
#
# Guardas, por esta ordem. Qualquer uma falha → sai com erro, sem deploy:
#   1. branch atual é main;
#   2. working tree limpo (sem alterações nem ficheiros por seguir fora do .gitignore);
#   3. depois de git fetch, main igual a origin/main (nem à frente, nem atrás);
#   4. test:franchise, test:sync-safety e test:health-gate passam.
# A guarda 2 volta a correr depois das suites: nada do que as suites deixem no disco
# entra na imagem.
#
# Uso (a partir de qualquer pasta do repo):
#   bash scripts/deploy.sh
#
# Testado em scripts/tests/deploy-guards.test.js (um repo temporário por caso).
set -euo pipefail

APP="alterpop-importer-app"
SUITES=("test:franchise" "test:sync-safety" "test:health-gate")

cd "$(dirname "$0")/.."

fail() {
  echo "[deploy] RECUSADO — $*" >&2
  echo "[deploy] nada foi enviado para o Fly." >&2
  exit 1
}

check_clean() {
  local dirty
  dirty="$(git status --porcelain)"
  if [ -n "$dirty" ]; then
    echo "$dirty" >&2
    fail "guarda 2: working tree não está limpo ($1). Commitar, descartar ou pôr no .gitignore."
  fi
}

# 1. branch
branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "main" ] || fail "guarda 1: branch atual é '$branch', não 'main'."
echo "[deploy] guarda 1 ok — branch main"

# 2. working tree
check_clean "antes das suites"
echo "[deploy] guarda 2 ok — working tree limpo"

# 3. main == origin/main
git fetch --quiet origin main || fail "guarda 3: git fetch origin main falhou."
local_sha="$(git rev-parse main)"
remote_sha="$(git rev-parse origin/main)"
if [ "$local_sha" != "$remote_sha" ]; then
  ahead="$(git rev-list --count origin/main..main)"
  behind="$(git rev-list --count main..origin/main)"
  fail "guarda 3: main local ≠ origin/main (${ahead} à frente, ${behind} atrás). Fazer push ou pull --ff-only primeiro."
fi
echo "[deploy] guarda 3 ok — main = origin/main"

# 4. suites
for suite in "${SUITES[@]}"; do
  echo "[deploy] guarda 4 — npm run $suite"
  npm run -s "$suite" >/dev/null 2>&1 || fail "guarda 4: $suite falhou. Correr 'npm run $suite' para ver o erro."
done
echo "[deploy] guarda 4 ok — ${SUITES[*]}"
check_clean "depois das suites"

echo "[deploy] vai para produção: $(git log -1 --format='%H %s')"
exec flyctl deploy -a "$APP"
