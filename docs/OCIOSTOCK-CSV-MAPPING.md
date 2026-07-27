# OcioStock CSV → Shopify mapping

Semicolon-delimited (`;`) CSV from OcioStock. Spanish column headers mapped to internal English fields, then synced via GraphQL Admin API.

## Column mapping

| CSV column (ES) | Internal field | Shopify target | Translation | Required (live) |
|-----------------|----------------|----------------|-------------|-----------------|
| `referencia` | `sku` | Variant `sku` | — | Yes |
| `ean` | `barcode` | Variant `barcode` | — | No |
| `nombre` | `title` | Product `title` | DeepL / glossary | Yes |
| `descripcion` | `description` | `descriptionHtml` | DeepL | No |
| `categoria_principal` | `category`, `categoryMain`, `categorySegments[]` | `productType`, `tags` | Glossary + DeepL | No |
| `marca` | `vendor` | Product `vendor` | — (brand names) | No |
| `precio_bruto` | `grossPrice` | Variant `price` | — | Yes if syncPrices |
| `precio_neto` | `netPrice` | Metafield `ociostock.net_price` | — | Yes if syncPrices (one of gross/net) |
| `stock_disponible` | `availableQuantity` | `inventorySetQuantities` | — | Yes (>= 0) |
| `hay_stock` | `hasStock` | Filter only | — | No |
| `disponibilidad` | `availability` | Filter only | — | No |
| `url_imagen_principal` | `imageUrl` | `productCreateMedia` | — | No |
| `url_imagen_principal_grande` | `imageUrlLarge` | Additional media | — | No |
| `csv_imagenes` | `extraImages[]` | Additional media | — | No |
| `xml_info_familias` | `franchises[]` | Curadoria (franchise prioritária) | — | No |
| `xml_campos_dinamicos` | `productTypePath`, segmentos | Curadoria + `productType` | — | No |
| `tipo_promocion` | `promotionType` | Filter only | — | No |
| `id_producto` | `supplierProductId` | — | — | No |

## Category glossary (deterministic ES → EN)

Loader: [`lib/importer/transform/glossary/index.js`](../lib/importer/transform/glossary/index.js). Ficheiros: [`categories.json`](../lib/importer/transform/glossary/categories.json) e [`segments.json`](../lib/importer/transform/glossary/segments.json).

### Schema `categories.json` (actualizado)

```json
{
  "mappings": {
    "Papelería / Escolar": "Stationery & School Supplies",
    "PAPELERIA / ESCOLAR": "Stationery & School Supplies",
    "Anime / Manga": "Anime & Manga",
    "ANIME / MANGA": "Anime & Manga"
  },
  "settings": {
    "fallback": "original",
    "caseSensitive": false
  }
}
```

| Chave | Tipo | Descrição |
|-------|------|-----------|
| `mappings` | `Record<string, string>` | Pares exactos ES → EN aplicados em `translateCategory()` antes do GraphQL. Sem chamadas a API. |
| `settings.fallback` | `"original"` \| `"empty"` | Se não houver match, mantém o valor do CSV (`original`) ou string vazia; misses acumulam em `results/{jobId}/missing_glossary.json`. |
| `settings.caseSensitive` | `boolean` | `false` (predefinição): lookup normalizado em maiúsculas; tolera variantes `PAPELERIA` / `Papelería`. |

`segments.json` segue o mesmo padrão para segmentos de segundo nível (ex.: `ONE PIECE`, `HELLO KITTY`).

Valores com pipe (`ANIME / MANGA|ONE PIECE`) traduzem cada segmento via `mappings` ou `segments.json`.

### `product_type_path` (OcioStock)

Extraído de `xml_campos_dinamicos` → campo interno `productTypePath` (ex.: `PAPELERIA / ESCOLAR|BOLÍGRAFOS`). Usado na curadoria de categorias bloqueadas e na detecção de franchises prioritárias.

## Curadoria activa (pós-transformação, pré-GraphQL)

Config: [`config/curation.json`](../config/curation.json). Lógica: [`lib/importer/curation/visibilityGatekeeper.js`](../lib/importer/curation/visibilityGatekeeper.js) (`shouldImport` / `resolveProductStatus`).

### Árvore de decisão (precedência)

1. **Marca** — `vendor` ∉ `allowedBrands` → `DRAFT` (`brand_not_allowed`).
2. **Categoria bloqueada** — qualquer candidato ( `categoria_principal`, segmentos, `productTypePath`, glossário ES/EN ) ∈ `blockedCategories` → `DRAFT` (`blocked_category`), **excepto** passo 3.
3. **Excepção franchise prioritária** — se a categoria estiver bloqueada **mas** existir sinal de `priorityFranchises` → `ACTIVE` (`priority_franchise_exception`). Só anula o bloqueio de categoria; a marca continua obrigatória.
4. **Aprovado** — `ACTIVE` (`approved`).

### Detecção de franchise prioritária

Extracção: [`parseFranchiseRefs`](../lib/importer/connectors/ociostock/parseFamilies.js) + [`collectFranchiseHaystacks`](../lib/importer/connectors/ociostock/parseFamilies.js).

| Fonte CSV / interno | Exemplo |
|---------------------|---------|
| `ref="..."` em `xml_info_familias` | `onepiece`, `MARVEL` |
| CDATA / texto em `<category>` | `ANIME / MANGA\|ONE PIECE` |
| `categoria_principal` e segmentos pipe | `ANIME / MANGA\|ONE PIECE` |
| `product_type_path` | `PAPELERIA / ESCOLAR\|MOCHILAS` (match por substring, com/sem acentos) |
| `nombre`, `descripcion` | "Bolígrafo … One Piece" |

Comparação case-insensitive; variantes sem acentos (`PAPELERIA` vs `Papelería`). Lista actual em `config/curation.json`: One Piece, Dragon Ball, Marvel, Star Wars, Pokemon.

Auditoria: `results/{jobId}/curated-drafts.json` (SKUs forçados a DRAFT).

### Spot-check de curadoria

```bash
npm run curation:spot-check   # requer DRY_RUN=true no .env
```

- Stream do CSV até capturar Caso 1 (`blocked_category`) e Caso 2 (`priority_franchise_exception` ou sintético).
- Valida **preço > 0** e **URL de imagem HTTP(S) válida**; rejeições em `results/spot-check-skipped.json`.
- Não executar mutations na Dev Store até o dry-run passar (`DRY_RUN=false` só após validação local).

## Validation (pre-GraphQL)

Ver [`lib/importer/validation/validateRecord.js`](../lib/importer/validation/validateRecord.js).

| Regra | Erro típico |
|-------|-------------|
| SKU obrigatório | `sku is required` |
| Título (live) | `title is required for live import` |
| Preço | `grossPrice must be > 0` / `netPrice must be > 0` |
| Imagem (`syncImages: true`) | `imageUrl required` / `invalid image URL` |
| Stock | `availableQuantity must be >= 0` |

## Rate limiting

All Admin GraphQL calls use [`lib/importer/shopifyClient.js`](../lib/importer/shopifyClient.js) with `p-limit`:

- `SHOPIFY_GRAPHQL_CONCURRENCY` (default: 2)
- `SHOPIFY_GRAPHQL_MIN_MS` (default: 250)
- Retry on HTTP 429 with exponential backoff

## DRY_RUN

Set `DRY_RUN=true` in `.env` to block live imports at the engine level. Use **Dry run** in the Admin UI for safe testing.

## Matrixify reference (bulk export)

For manual bulk operations, align columns with Matrixify:

| Matrixify | OcioStock source |
|-----------|------------------|
| SKU | `referencia` |
| Handle | Shopify-generated or existing |
| Title | `nombre` (translated EN) |
| Variant Price | `precio_bruto` |
