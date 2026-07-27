# Opções de importação — Alterpop (A / B / C)

Referência rápida para o primeiro ciclo controlado na **Dev Store** (`alterpop-store.myshopify.com`), com **curadoria ACTIVE/DRAFT** em [`config/curation.json`](../config/curation.json).

---

## Impacto no inventário da Dev Store

| Modo | Produtos novos | Stock / inventário | Visibilidade na loja |
|------|----------------|--------------------|----------------------|
| **Dry run** | Nenhum (simulação) | Nenhum | — |
| **Products only** | Create/update por SKU | **Não altera** quantidades | ACTIVE visíveis no canal; DRAFT ocultos |
| **Inventory only** | Não cria produtos | Actualiza `availableQuantity` por SKU existente | — |
| **Products + inventory** (predefinição) | Create/update + metafields/preço/imagem | Sincroniza stock na localização configurada | Igual à coluna de produtos |

**Curadoria (sempre activa no motor):**

1. Marca ∉ whitelist → **DRAFT** (`brand_not_allowed`)
2. Categoria bloqueada → **DRAFT** (`blocked_category`)
3. Franchise prioritária anula bloqueio de categoria → **ACTIVE** (`priority_franchise_exception`)
4. Restantes aprovados → **ACTIVE** (`approved`)

O campo Shopify `status` é definido em `ProductImporter` via `resolveProductStatus()` **antes** de cada mutation GraphQL.

**Risco:** `SYNC_LIMIT=0` processa ~29k SKUs — usar **10–50** no primeiro live. Inventário em massa só faz sentido depois dos produtos existirem com o mesmo SKU.

---

## Opção A — App embedded (recomendada)

Motor Matrixify-style já integrado: stream CSV, validação, glossário, curadoria, `p-limit`, relatórios em `results/{jobId}/`.

### Abrir primeiro

1. **UI:** `app/routes/app.import.jsx` (página **Import** no Admin)
2. **Config curadoria:** `config/curation.json`
3. **Regras Cursor:** `.cursor/rules/alterpop-importer.mdc`

### Sequência operacional

```bash
# Terminal 1 — app online
cd alterpop-importer && npm run dev
```

No Admin: **Apps → alterpop-importer → Import**

1. **Preview count** (opcional) com filtros
2. **Dry run** — `SYNC_LIMIT=10`, sem API
3. Validar em **Jobs** as métricas ACTIVE / DRAFT
4. **Run import** só com `DRY_RUN=false` no `.env` e confirmação explícita

### Validação na UI

- Painel **Job status** com ACTIVE / DRAFT e motivos (`blocked_category`, etc.)
- Ficheiros: `results/{jobId}/curation-summary.json`, `curated-drafts.json`

---

## Opção B — Matrixify (manual)

Export/import CSV no Admin via app Matrixify. Útil para revisão humana em massa; **não substitui** a curadoria automática do motor.

### Colunas sugeridas (produtos)

| Matrixify | Origem OcioStock / motor |
|-----------|--------------------------|
| SKU | `referencia` |
| Title | `nombre` (EN após glossário) |
| Vendor | `marca` |
| Status | `ACTIVE` ou `DRAFT` (regra curadoria) |
| Variant Price | `precio_bruto` |
| Metafield: ociostock.net_price | `precio_neto` |

Gerar pré-visualização DRY (10 SKUs) sem Shopify:

```bash
node scripts/load-test-dry-run.js 10
# Ver results/<jobId>/curated-drafts.json para SKUs DRAFT
```

Importar no Matrixify **só depois** de validar o dry-run.

---

## Opção C — Scripts CLI (sem UI)

| Script | Uso |
|--------|-----|
| `node scripts/load-test-dry-run.js 10` | Curadoria + validação, sem API |
| `node scripts/curation-spot-check.js` | Dois casos de teste da árvore de decisão |
| `npm run import:dry-run` | Stream completo em DRY_RUN (cuidado com tempo) |

Live via CLI exige sessão Prisma + `DRY_RUN=false` (mesmas regras que a Opção A).

---

## Ordem recomendada (Go-Live controlado)

1. Opção **A** → Import → Dry run → 10 SKUs  
2. Opção **A** → Jobs → confirmar `curatedDrafts` vs `productsActive`  
3. Opção **A** → Run import live (10 SKUs, products + inventory)  
4. Opção **B** só se precisares de edição manual em folha de cálculo  

---

## Ficheiro a abrir **agora**

**`app/routes/app.import.jsx`** no Admin (com `npm run dev` a correr), ou em código:

**`docs/IMPORT-OPTIONS-ABC.md`** (este ficheiro) + **`config/curation.json`**.
