# Shopify CLI — Alterpop Importer

## Prerequisites

- Node 20+
- Shopify CLI 3.x (`npm run shopify -- version`)
- Dev Dashboard app linked (`client_id` in `shopify.app.toml`)

## Daily development

```bash
cd alterpop-importer
shopify app dev
```

This replaces the old `npm run auth` flow. The CLI:

1. Starts the React Router dev server
2. Opens an HTTPS tunnel
3. Updates `application_url` and redirect URLs on the linked app
4. Prompts you to install on your dev store

Open the app from **Shopify Admin → Apps → alterpop-importer**.

## Config

```bash
shopify app config use shopify.app.toml
shopify app env show
```

`shopify.app.toml` has `embedded = true`. Scopes:

```
read_products, write_products, read_inventory, write_inventory, read_locations
```

## Deploy

```bash
shopify app deploy
```

Deploys app configuration to Shopify. For the web app itself, build and host separately:

```bash
npm run setup
npm run build
npm run start
```

Set `SHOPIFY_APP_URL` to your production URL in the hosting environment.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| App não carrega / spinner infinito | `npm run shopify:reset-session` → reinicia `npm run dev` → abre Apps → alterpop-importer no Admin |
| `401 Invalid access token` no import | Sessão expirada; mesmo reset acima |
| `Content-Type` em `/auth/login` | Corrigido no código — actualiza e reinicia o dev server |
| Redirect to wrong URL | Run `shopify app dev` (not old `localhost:3456` OAuth) |
| `Invalid API key` | Match `SHOPIFY_API_KEY` in `.env` with `client_id` in TOML |
| Import needs location | Set location GID in Settings or leave empty for auto-detect |
| Long import timeout | Use row limit in Import page; jobs run async with polling |

### App embedded presa no loading

1. Para o dev server (`Ctrl+C`).
2. `npm run shopify:reset-session` — apaga tokens stale em `prisma/dev.sqlite`.
3. `npm run dev` — usa o URL do tunnel que o CLI imprimir.
4. No Admin: **Apps → alterpop-importer** (não abras só `localhost`).
5. Se pedir permissões, aceita; o Dashboard deve aparecer.
6. Opcional: desinstala e reinstala a app na Dev Store se o passo 4 falhar.

## Removed (CLI era)

- `npm run auth` — manual OAuth on port 3456
- `shopify.app.alterpop-sync.toml` — duplicate app config
- Fixed `shpat_` Custom App tokens

Legacy scripts are archived under `legacy-cli/` for reference only.
