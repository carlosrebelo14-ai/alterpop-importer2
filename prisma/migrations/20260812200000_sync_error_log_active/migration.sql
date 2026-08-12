-- SyncErrorLog nunca era limpo por reindexações/resets (só curation-queue.json era
-- reconstruída), fazendo as duas fontes de contagem de erros dessincronizar sempre
-- que havia uma reindexação completa. Em vez de apagar (perde histórico útil para a
-- página "Logs de Erro"), marca-se `active=false` — resolvido normalmente por
-- clearSyncErrorForSku(), ou invalidado em massa depois de uma reindexação completa.
ALTER TABLE "SyncErrorLog" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "SyncErrorLog_shop_active_idx" ON "SyncErrorLog"("shop", "active");
