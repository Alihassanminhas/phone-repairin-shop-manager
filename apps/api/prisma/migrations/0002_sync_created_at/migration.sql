ALTER TABLE "Invoice"
ADD COLUMN "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "RepairStatusHistory"
ADD COLUMN "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "Invoice_ownerId_createdAt_idx"
ON "Invoice"("ownerId", "createdAt");

CREATE INDEX "RepairStatusHistory_ownerId_createdAt_idx"
ON "RepairStatusHistory"("ownerId", "createdAt");
