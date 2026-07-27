# Handover Alterpop Importer → Antigravity

**Data:** 2026-05-29  
**Projecto:** `alterpop-importer` (Shopify embedded app, React Router + Prisma/SQLite)  
**Path local:** `/Users/carlosrebelo/Desktop/alterpop-importer`  
**Utilizador:** Diretor de Orquestra (não programador) — comunicar em PT-PT, tom técnico acessível.

---

## 1. O que é isto

App Shopify **alterpop-importer** para:

1. **Indexar** catálogo OcioStock (CSV) → SQLite local (filtro “elite”, facets, dedup).
2. **Curar** produtos no dashboard (aprovar/rejeitar, regras smart, Gemini).
3. **Sincronizar** aprovados para a loja Shopify (Admin GraphQL).

Modo operacional desejado: **SaaS contínuo** (noite inteira), com monitorização externa — **não** depender de pinger HTTP interno.

---

## 2. Lojas e contextos (CRÍTICO)

| Contexto | Domínio | Notas |
|----------|---------|--------|
| **Loja real (OAuth/sessão)** | `jyr17t-wr.myshopify.com` | `.env` + `data/sessions/offline_jyr17t-wr.myshopify.com.json` |
| **Dev store CLI** | `alterpop-store.myshopify.com` | Aparece em `shopify app dev` — pode confundir |
| **Mencionada pelo utilizador** | `alterpop-2.myshopify.com` | **Não existe** na org Alterpop (erro CLI) |

**Regra:** OAuth e import live devem usar **`jyr17t-wr.myshopify.com`**. Abrir a app numa loja diferente da autorizada → ecrã branco no Admin.

---

## 3. App Shopify (Partner)

- **App ID:** `365975240705`
- **Client ID:** `b8beed550d16a006068ca696bc4bf74f`
- **Última versão deploy:** `alterpop-importer-10`
- **Scopes:** `read/write products`, `read/write inventory`, `read_locations`, `read_orders`
- **Credenciais:** `.env` (`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`) — **nunca commitar**

Deploy config:

```bash
cd "/Users/carlosrebelo/Desktop/alterpop-importer"
shopify app deploy --allow-updates
```

---

## 4. Estado actual (2026-05-29)

### Catálogo SQLite (OcioStock → local)

| Métrica | Valor |
|---------|--------|
| Estado indexação | **completed** |
| Linhas CSV lidas | 29 605 |
| Produtos na SQLite | **26 347** |
| Rejeitados (filtro) | 3 258 |
| Ficheiro status | `data/catalog-index/jyr17t-wr.myshopify.com-rebuild-status.json` |

Motivos rejeição (top): `blockedBrand` 1588, `badCategory` 675, `liquidation` 539, `outOfStock` 304.

### App UI

- **Resolvido:** ecrã branco no Admin (tunnel OAuth desalinhado + reautorização).
- Utilizador confirmou **“Ok resolvido”** após sync URLs + reauth.

### Shopify live

- `DRY_RUN=false` no `.env` (go-live pedido pelo utilizador em sessões anteriores).
- Sincronização para Shopify: usar sempre **`DRY_RUN=true` primeiro** e validar logs antes de mutação real (regra Alterpop).

---

## 5. Infra / DevOps (implementado nesta sessão)

### Health check público

- **Rota:** `GET /api/health`
- **Resposta:** `200` + `{ "status": "alive", "timestamp": ... }`
- **Sem OAuth** — para UptimeRobot / Better Stack (intervalo ~5 min).
- **Removido:** `lib/server/serverKeepAlive.server.js` (pinger interno HTTP — falhava com idle timeout do hosting).

### SQLite / Prisma

- `lib/prisma/configureSqlite.server.js`: WAL + `busy_timeout` (default 5000 ms, env `SQLITE_BUSY_TIMEOUT_MS`).
- **Importante:** `PRAGMA journal_mode=WAL` usa `$queryRawUnsafe` (não `$executeRawUnsafe` — devolve linha).
- Watchdog de ligação Prisma em `app/db.server.js` (recupera após reinício; **não** substitui ping externo).

### Indexação com retoma (checkpoint)

- Checkpoint: `checkpointScanned` / `checkpointIndexed` em `*-rebuild-status.json`.
- Retoma automática se `state=failed` e checkpoint > 0.
- CSV local em cache: `lib/importer/catalog/ensureLocalOcioStockCsv.server.js` (evita stream HTTP abortado).
- Inserção idempotente: `catalogInsertBatch.server.js` ignora SKUs já existentes.
- UI: banner «Retomar indexação» / «Recomeçar do zero» no dashboard.

---

## 6. Como correr

### Desenvolvimento (tunnel Cloudflare — muda sempre)

```bash
cd "/Users/carlosrebelo/Desktop/alterpop-importer"
npm run dev   # shopify app dev
```

- No terminal CLI: **`p`** = Open app preview (URL tunnel correcto).
- Copiar `Using URL: https://....trycloudflare.com` → actualizar `.env`:
  - `SHOPIFY_APP_URL=...`
  - `APP_URL=...`
- Actualizar `shopify.app.toml` (`application_url`, `redirect_urls`) + `shopify app deploy --allow-updates`.
- Reauth OAuth:

```bash
SHOPIFY_APP_URL=https://<tunnel-atual> npm run oauth:url
# Abrir URL gerado no browser
```

**Não usar URLs de tunnels antigos** — Cloudflare expira → link “em baixo” / ecrã branco.

### Produção / noite (estável)

```bash
npm run build
APP_URL=https://<url-publica-fixa> npm run start:resilient
# Terminal 2 (opcional):
npm run sync:daemon:resilient
```

**Evitar** `shopify app dev` para operação longa (HMR/restarts).

### Indexação manual

```bash
SHOP=jyr17t-wr.myshopify.com node scripts/full-catalog-reindex.js
RESUME=1 SHOP=jyr17t-wr.myshopify.com node scripts/full-catalog-reindex.js
```

### Import live Shopify

```bash
DRY_RUN=true SYNC_LIMIT=3 node scripts/run-live-import.js   # simulação primeiro
DRY_RUN=false node scripts/run-live-import.js               # só após validação
```

---

## 7. Ficheiros-chave

| Área | Path |
|------|------|
| Config Shopify | `shopify.app.toml` |
| Env | `.env`, `.env.example` |
| OAuth / sessão | `data/sessions/offline_jyr17t-wr.myshopify.com.json` |
| Status indexação | `data/catalog-index/*-rebuild-status.json` |
| Worker indexação | `workers/catalog-index-worker.mjs` |
| Stream + checkpoint | `lib/importer/catalog/syncCatalogWithProgress.server.js`, `indexingStream.server.js` |
| Health | `app/routes/api.health.jsx` |
| Erros | `results/errors.json` |
| Dashboard | `app/routes/app._index.jsx` |

---

## 8. Problemas conhecidos e soluções

| Sintoma | Causa provável | Acção |
|---------|----------------|--------|
| Ecrã branco no Admin | Tunnel OAuth desatualizado | `npm run dev` → `p` ou reauth com URL novo |
| `redirect_uri not whitelisted` | `shopify.app.toml` ≠ tunnel activo | Deploy + redirect_urls |
| Indexação para a meio | Stream HTTP CSV | CSV em cache + retoma (`RESUME=1` ou «Retomar») |
| Retoma começa do 0 | `clearFirst: true` sem checkpoint | Usar retoma automática (já corrigido) |
| `database is locked` | SQLite concorrência | WAL + busy_timeout (já activo) |
| `alterpop-2.myshopify.com` | Loja inexistente na org | Usar `jyr17t-wr` |
| Gemini 429 | Rate limit free tier | `GEMINI_RPM=4`, retries existentes |
| `shopify app dev --reset` falha em CI | Prompt interactivo org | Correr no terminal local do utilizador |

---

## 9. Regras operacionais Alterpop (obrigatório)

1. **DRY_RUN=true** antes de qualquer mutation real na Shopify.
2. Mostrar sumário ao utilizador: produtos OK/erro, DRAFT vs ACTIVE, erros API.
3. Erros → `results/errors.json` (append estruturado), não crash silencioso.
4. Comunicação **PT-PT**, acessível.
5. **Não commitar** `.env`, sessões, secrets.

---

## 10. Próximos passos sugeridos

1. **Hosting com URL fixa** (Render/Fly/Railway) — eliminar dependência de trycloudflare em produção.
2. **UptimeRobot** em `https://<APP_URL>/api/health` (5 min).
3. **Sync Shopify** dos ~26k indexados — staging com `DRY_RUN=true`, depois batches.
4. Alinhar **dev store CLI** vs loja real se o utilizador quiser testar só em `jyr17t-wr`.
5. Commit das alterações de infra (health, SQLite, checkpoint) se ainda não estiverem em git.

---

## 11. Comandos rápidos de diagnóstico

```bash
# Health local (porta do vite no log do dev)
curl -s http://localhost:<porta>/api/health

# Total produtos SQLite
node -e "import { getCatalogProductTotal } from './lib/importer/catalog/catalogProductsDb.server.js'; console.log(await getCatalogProductTotal('jyr17t-wr.myshopify.com'))"

# OAuth URL
SHOPIFY_APP_URL=https://<tunnel> npm run oauth:url

# Build
npm run build
```

---

## 12. Contacto / decisões do utilizador

- Quer operação **autónoma e robusta** (catálogo completo, sync noite, sem parar aos ~14k).
- Prefere validar logs antes de mutações reais, mas já pediu go-live em momentos (`DRY_RUN=false`).
- Não é programador — explicar o **quê** e **porquê** antes de correr scripts destrutivos.

---

*Documento gerado para continuidade Antigravity. Actualizar tunnel URLs e versão deploy quando o ambiente mudar.*
