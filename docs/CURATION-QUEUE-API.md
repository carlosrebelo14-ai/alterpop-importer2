# Fila de curadoria — `server/data/curation-queue.json`

Ponto de verdade entre leitura do CSV OcioStock e importação Shopify.

## Modelo de item

```json
{
  "sku": "3521320802312",
  "title_en": "Figure Money Box Sung Jinwoo Solo Leveling 15cm",
  "status": "PENDING",
  "reason": "brand_not_allowed",
  "shopifyStatus": "DRAFT",
  "metadata": {
    "title_es": "Figura hucha Sung Jinwoo Solo Leveling 15cm",
    "vendor": "PLASTOY",
    "category": "Anime & Manga",
    "curationReasons": ["brand_not_allowed"],
    "queuedAt": "2026-05-25T13:00:00.000Z"
  }
}
```

| Campo | Valores |
|-------|---------|
| `status` | `PENDING`, `APPROVED`, `REJECTED` |
| `shopifyStatus` | `DRAFT` ou `ACTIVE` na próxima sync |

## API (autenticação Admin Shopify)

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/curation/queue` | Lista pendentes (`?status=PENDING`, `ALL`) |
| POST | `/api/curation/queue/:sku/approve` | `approveProduct(sku)` → ACTIVE |
| POST | `/api/curation/queue/:sku/reject` | `rejectProduct(sku)` → DRAFT |

## Fluxo

1. **Dry run / import stream** → `upsertCurationQueueFromRecord()` enfileira SKU como `PENDING`.
2. **UI futura** → GET pendentes → Aprovar/Rejeitar.
3. **Import live** → `resolveProductStatus()` lê fila: `APPROVED` força **ACTIVE** mesmo com `brand_not_allowed`.

## Código

- `lib/curation/curationQueue.server.js` — leitura/escrita JSON, `approveProduct`, `rejectProduct`
- `lib/importer/curation/visibilityGatekeeper.js` — override na sync
