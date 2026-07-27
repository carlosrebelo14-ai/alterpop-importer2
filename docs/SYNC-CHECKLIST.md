# Checklist de Sincronização Alterpop

Estado do repositório `alterpop-importer`. Atualizar após cada release.

## P0 - Estabilidade e Rate Limiting

- [x] Implementar `p-limit` no `shopifyClient.js` (via `shopifyRateLimiter.js`)
- [x] Chunking 50 produtos + pausa 2000 ms entre chunks no `ProductImporter.js`
- [ ] Teste de carga (100 SKUs) com monitorização de erros 429 — correr: `node scripts/load-test-dry-run.js 100` (dry) ou live na dev store

## P1 - Validação e Integridade

- [x] Implementar `validateRecord.js` (SKU, Price > 0, Qty >= 0, preços negativos)
- [x] Integrar log de `validationSkipped` — `results/{jobId}/validation-skipped.json` + métrica em `summary.json`
- [x] Adicionar defesa contra URLs de imagem inválidas (quando `syncImages` em live)

## P2 - Limpeza de Segurança (Legado)

- [x] Remover `.env.save` e `.env*` no `.gitignore`
- [x] Limpar documentação OAuth legada no `.env.example`
- [ ] Regenerar manifestos — `shopify app deploy` (remove artefactos stale em `.shopify/deploy-bundle/`)

## P3 - Glossário de Categorias (ES -> EN)

- [x] Criar estrutura em `lib/importer/transform/glossary/` (JSON)
- [x] Substituir lógica hardcoded por loader de JSON (`glossary/index.js`)
