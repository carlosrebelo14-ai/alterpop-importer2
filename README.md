# Alterpop Importer (Shopify embedded app)

Internal **Matrixify-style** bulk importer: OcioStock CSV (Spanish) → English field mapping → Shopify **GraphQL Admin API** (products + inventory).

The app runs **embedded in Shopify Admin** (React Router + Polaris web components). OAuth and sessions are handled by `@shopify/shopify-app-react-router` and Prisma — no manual `localhost:3456` OAuth server.

## Quick start

```bash
cd alterpop-importer
npm install
cp .env.example .env   # if present; otherwise create .env
```

### 1. Environment (`.env`)

| Variable | Purpose |
|----------|---------|
| `SHOPIFY_API_KEY` | Client ID from Dev Dashboard (`b8beed55…`) |
| `SHOPIFY_API_SECRET` | Client secret |
| `OCIOSTOCK_FEED_URL` | URL do feed OcioStock (segredo: só vem do ambiente; na Fly, `fly secrets set`) |
| `TRANSLATION_PROVIDER` | `deepl` (recommended), `libretranslate`, or `passthrough` |
| `TRANSLATION_API_KEY` | DeepL key — required for English product text |
| `DRY_RUN` | `true` blocks live imports (keep on until ready) |
| `SHOPIFY_GRAPHQL_CONCURRENCY` | Max parallel GraphQL requests (default: 2) |
| `SHOPIFY_GRAPHQL_MIN_MS` | Min ms between requests (default: 250) |

Full CSV column reference: [docs/OCIOSTOCK-CSV-MAPPING.md](./docs/OCIOSTOCK-CSV-MAPPING.md)

Shop-specific overrides (CSV URL, limits, translation) can also be saved in **Admin → Apps → alterpop-importer → Settings**.

### 2. Development

```bash
shopify app dev
```

- Creates an HTTPS tunnel and updates app URLs automatically
- Install on **alterpop.myshopify.com** when prompted
- Open **Apps → alterpop-importer** in Admin

### 3. Admin UI

| Page | Path | Description |
|------|------|-------------|
| Dashboard | `/app` | Curadoria, radar, publicação Shopify, logs de erro |
| Settings | `/app/settings` | OcioStock, tradução, exclude-list.json, reset Shopify |

Rotas legadas (`/app/import`, `/app/jobs`, `/app/history`) redireccionam para o Dashboard.

Large catalog imports run **asynchronously** (background job + status polling).

### 4. Production (Fly.io, `alterpop-importer-app`)

**Único caminho de deploy:**

```bash
bash scripts/deploy.sh
```

Recusa o deploy, sem enviar nada, se: o branch não for `main`; o working tree tiver
alterações ou ficheiros por seguir fora do `.gitignore`; `main` não for igual a
`origin/main` depois de `git fetch`; ou `test:franchise`, `test:sync-safety` ou
`test:health-gate` falharem. Imprime o commit que vai para produção e só então corre
`flyctl deploy -a alterpop-importer-app`. Nunca correr `flyctl deploy` à mão: o flyctl
empacota o diretório local, não o GitHub (incidente de 28/09/2026).

Flags de ambiente da Decisão 31/32 (ambas desligadas por omissão; ver `.env.example`):
`PRICE_MODE=NET` (preço sem IVA) e `THEME_GUARD=ON` (recusa o lote se o contrato do tema, lido com `read_themes`, estiver inválido).
Depois de `scripts/deploy.sh`, aplicar as tabelas novas com `fly ssh console -a alterpop-importer-app -C "sh -lc 'cd /app && npm run db:push'"`.

Relatórios gerados por scripts vão para `reports/` (no `.gitignore`), nunca para a raiz.

Para correr um script no Fly sem deploy: [docs/FLY-STAGING.md](./docs/FLY-STAGING.md).

## Project layout

```
app/                  React Router routes (embedded UI)
lib/importer/         OcioStock connector, translators, importers, jobs
prisma/               Session storage (SQLite by default)
results/              Per-job reports (summary, success, failed, skipped)
data/settings/        Per-shop settings JSON
.cursor/rules/        Cursor project rules for this repo
docs/                 OcioStock CSV mapping documentation
```

## Engineering standards

- **GraphQL only** via `lib/importer/shopifyClient.js` with `p-limit` rate limiting and 429 backoff
- **Pre-flight validation** in `lib/importer/validation/validateRecord.js`
- **Category glossary** ES→EN before DeepL (`lib/importer/transform/categoryGlossary.js`)
- **DRY_RUN** enforced in UI and blocked at engine level when `DRY_RUN=true` in `.env`

## OcioStock CSV

O URL do feed é um segredo: define `OCIOSTOCK_FEED_URL` no ambiente (`.env` em desenvolvimento, `fly secrets set OCIOSTOCK_FEED_URL=…` na Fly). Não há URL por omissão: sem a variável (nem `OCIOSTOCK_CSV_PATH`) a app falha com um erro claro.

Spanish columns are mapped to English (`referencia` → `sku`, `stock_disponible` → `availableQuantity`, etc.).

**Translation:** Enable **Translate to English** in Settings (DeepL + API key). Titles, descriptions, and categories sync to Shopify in EN. Filter labels in the Import page are also translated.

**Images & prices:** Live import attaches `url_imagen_principal` via Shopify media API. Variant price comes from the cost (`precio_distribuidores`) plus the global margin — see [Variant price](./docs/OCIOSTOCK-CSV-MAPPING.md#variant-price) (flag `PRICE_MODE`); `precio_bruto` is the PVPR and net price (`precio_neto`) is stored in metafield `ociostock.net_price`.

**Filters:** Refresh catalog index on Import, then select product types, subcategories, brands, franchises, and in-stock only before running.

## Import modes

- `UPDATE_ONLY` — update existing Shopify variants matched by SKU
- `CREATE_AND_UPDATE` — create missing products, then update

## Security

- `.env*` is gitignored (except `.env.example`)
- Never commit secrets or session files
- Rotate API secrets if they were exposed in chat or logs

See [SHOPIFY-CLI.md](./SHOPIFY-CLI.md) for CLI commands and troubleshooting.
