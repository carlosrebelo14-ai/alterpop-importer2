-- CreateTable
CREATE TABLE "BackgroundImportJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "progressPercent" REAL NOT NULL DEFAULT 0,
    "processedRows" INTEGER NOT NULL DEFAULT 0,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "currentSku" TEXT,
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "payload" TEXT NOT NULL,
    "error" TEXT,
    "resultsJobId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME
);

CREATE INDEX "BackgroundImportJob_shop_state_idx" ON "BackgroundImportJob"("shop", "state");
CREATE INDEX "BackgroundImportJob_createdAt_idx" ON "BackgroundImportJob"("createdAt");
