#!/usr/bin/env bash
# Reset limpo: sessão OAuth + DRY_RUN + relink CLI (túnel novo).
set -euo pipefail
cd "$(dirname "$0")/../.."

CLIENT_ID=$(grep -E '^client_id' shopify.app.toml | head -1 | sed 's/.*= *"\(.*\)"/\1/')

echo "=== Alterpop — reset ambiente dev ==="

# Sessões Prisma + ficheiros
npm run shopify:reset-session 2>/dev/null || node scripts/setup/reset-shopify-session.js
rm -rf data/sessions/*.json 2>/dev/null || true

# Modo seguro
if grep -q '^DRY_RUN=' .env 2>/dev/null; then
  sed -i '' 's/^DRY_RUN=.*/DRY_RUN=true/' .env
else
  echo 'DRY_RUN=true' >> .env
fi

# URL stale no .env quebra OAuth — o CLI injecta HOST em dev
if grep -q '^SHOPIFY_APP_URL=' .env 2>/dev/null; then
  sed -i '' '/^SHOPIFY_APP_URL=/d' .env
  echo "(removido SHOPIFY_APP_URL fixo do .env — o CLI atualiza o túnel)"
fi

echo "DRY_RUN=$(grep '^DRY_RUN=' .env | cut -d= -f2)"

echo ""
echo "Relink app (túnel / redirect URLs)..."
shopify app config link --reset --client-id "$CLIENT_ID" || {
  echo "AVISO: config link falhou (pode precisar de confirmação manual no terminal)."
}

echo ""
echo "Próximo passo: npm run dev"
echo "Depois abre a app pelo preview do CLI (não URL antiga de túneis anteriores)."
