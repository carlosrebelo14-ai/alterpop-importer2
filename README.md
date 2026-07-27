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
| `OCIOSTOCK_CSV_URL` | OcioStock plain CSV export URL |
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

### 4. Production

```bash
shopify app deploy
npm run setup    # prisma migrate
npm run build
npm run start
```

Host on Fly.io, Railway, or similar with `SHOPIFY_APP_URL` set to your public URL.

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

Default URL (set in `.env` or Settings):

```
https://ociostock.gesio.be/dyndata/exportaciones/csvzip/catalog_1_50_54_2_40836fd3ce5ea622a4d34a8aa6c8cda3_csv_plain.csv
```

Spanish columns are mapped to English (`referencia` → `sku`, `stock_disponible` → `availableQuantity`, etc.).

**Translation:** Enable **Translate to English** in Settings (DeepL + API key). Titles, descriptions, and categories sync to Shopify in EN. Filter labels in the Import page are also translated.

**Images & prices:** Live import attaches `url_imagen_principal` via Shopify media API. Gross price (`precio_bruto`) sets variant price; net price (`precio_neto`) is stored in metafield `ociostock.net_price`.

**Filters:** Refresh catalog index on Import, then select product types, subcategories, brands, franchises, and in-stock only before running.

## Import modes

- `UPDATE_ONLY` — update existing Shopify variants matched by SKU
- `CREATE_AND_UPDATE` — create missing products, then update

## Security

- `.env*` is gitignored (except `.env.example`)
- Never commit secrets or session files
- Rotate API secrets if they were exposed in chat or logs

See [SHOPIFY-CLI.md](./SHOPIFY-CLI.md) for CLI commands and troubleshooting.
