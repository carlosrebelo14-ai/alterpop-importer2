# Importação em background

A importação OcioStock corre numa **fila persistente** (SQLite via Prisma). A UI não bloqueia o browser.

## API

### `POST /api/import/start`

Enfileira um job. Corpo: `FormData` (mesmos campos da página Import).

Resposta:

```json
{ "ok": true, "jobId": "2026-05-25T12-00-00", "state": "queued" }
```

### `GET /api/import/status/:jobId`

Polling do estado:

```json
{
  "ok": true,
  "jobId": "2026-05-25T12-00-00",
  "state": "running",
  "progressPercent": 42.5,
  "processedRows": 5,
  "totalRows": 10,
  "currentSku": "ABC123"
}
```

Estados: `queued` → `running` → `completed` | `failed`.

## Auditoria

Cada SKU regista-se em `logs/execution-history.log` (TSV):

`timestamp` · `SKU` · `ação` (`importado` | `atualizado` | `rejeitado`) · `motivo_curadoria` · `jobId`

## Fluxo para o gestor

1. Clicar **Importar** ou **Dry run**.
2. Fechar o browser — o worker no servidor continua (`ensureBackgroundWorkerStarted` no arranque).
3. Reabrir a app e consultar o estado na página Import ou o ficheiro de log.
