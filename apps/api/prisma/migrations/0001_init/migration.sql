-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "RepairStatus" AS ENUM ('received', 'diagnosing', 'awaiting_approval', 'waiting_for_parts', 'in_repair', 'ready', 'delivered', 'cancelled');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('cash', 'bank_transfer', 'other');

-- CreateTable
CREATE TABLE "Owner" (
    "id" UUID NOT NULL,
    "singleton" INTEGER NOT NULL DEFAULT 1,
    "email" VARCHAR(254) NOT NULL,
    "passwordHash" VARCHAR(200) NOT NULL,
    "recoveryCodeHash" VARCHAR(64) NOT NULL,
    "shopName" VARCHAR(120) NOT NULL,
    "shopTimezone" VARCHAR(80) NOT NULL DEFAULT 'Asia/Karachi',
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Owner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshSession" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "familyId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "replacedByHash" VARCHAR(64),

    CONSTRAINT "RefreshSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "phone" VARCHAR(32) NOT NULL,
    "alternatePhone" VARCHAR(32),
    "address" VARCHAR(500),
    "notes" VARCHAR(2000),
    "version" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Repair" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "receiptNumber" VARCHAR(48) NOT NULL,
    "brand" VARCHAR(80) NOT NULL,
    "model" VARCHAR(120) NOT NULL,
    "imei" VARCHAR(16),
    "reportedProblem" VARCHAR(2000) NOT NULL,
    "inspectionNotes" VARCHAR(4000),
    "accessories" VARCHAR(500),
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expectedDeliveryDate" DATE,
    "deliveredAt" TIMESTAMPTZ(3),
    "status" "RepairStatus" NOT NULL DEFAULT 'received',
    "estimatedCostPaisa" BIGINT,
    "finalCostPaisa" BIGINT,
    "internalNotes" VARCHAR(4000),
    "version" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Repair_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "repairId" UUID NOT NULL,
    "amountPaisa" BIGINT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "transactionReference" VARCHAR(160),
    "note" VARCHAR(500),
    "idempotencyKey" UUID NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "paidAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentReversal" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "repairId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "amountPaisa" BIGINT NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "idempotencyKey" UUID NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "reversedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentReversal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "repairId" UUID NOT NULL,
    "invoiceCode" VARCHAR(48) NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "customerNameSnapshot" VARCHAR(120) NOT NULL,
    "customerPhoneSnapshot" VARCHAR(32) NOT NULL,
    "repairDescriptionSnapshot" VARCHAR(2400) NOT NULL,
    "totalPaisa" BIGINT NOT NULL,
    "paidPaisa" BIGINT NOT NULL,
    "balancePaisa" BIGINT NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepairStatusHistory" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "repairId" UUID NOT NULL,
    "fromStatus" "RepairStatus",
    "toStatus" "RepairStatus" NOT NULL,
    "note" VARCHAR(500),
    "changedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepairStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncOperation" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "operationId" UUID NOT NULL,
    "clientId" UUID NOT NULL,
    "entityType" VARCHAR(40) NOT NULL,
    "entityId" UUID NOT NULL,
    "resultVersion" INTEGER,
    "resultJson" JSONB,
    "processedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "eventType" VARCHAR(80) NOT NULL,
    "subjectId" UUID,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthRateLimit" (
    "bucketKey" VARCHAR(64) NOT NULL,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AuthRateLimit_pkey" PRIMARY KEY ("bucketKey")
);

-- CreateIndex
CREATE UNIQUE INDEX "Owner_singleton_key" ON "Owner"("singleton");

-- CreateIndex
CREATE UNIQUE INDEX "Owner_email_key" ON "Owner"("email");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshSession_tokenHash_key" ON "RefreshSession"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshSession_ownerId_revokedAt_expiresAt_idx" ON "RefreshSession"("ownerId", "revokedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "RefreshSession_familyId_revokedAt_idx" ON "RefreshSession"("familyId", "revokedAt");

-- CreateIndex
CREATE INDEX "Customer_ownerId_name_idx" ON "Customer"("ownerId", "name");

-- CreateIndex
CREATE INDEX "Customer_ownerId_phone_idx" ON "Customer"("ownerId", "phone");

-- CreateIndex
CREATE INDEX "Customer_ownerId_updatedAt_idx" ON "Customer"("ownerId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_id_ownerId_key" ON "Customer"("id", "ownerId");

-- CreateIndex
CREATE INDEX "Repair_ownerId_status_receivedAt_idx" ON "Repair"("ownerId", "status", "receivedAt");

-- CreateIndex
CREATE INDEX "Repair_ownerId_updatedAt_idx" ON "Repair"("ownerId", "updatedAt");

-- CreateIndex
CREATE INDEX "Repair_ownerId_expectedDeliveryDate_idx" ON "Repair"("ownerId", "expectedDeliveryDate");

-- CreateIndex
CREATE UNIQUE INDEX "Repair_id_ownerId_key" ON "Repair"("id", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "Repair_ownerId_receiptNumber_key" ON "Repair"("ownerId", "receiptNumber");

-- CreateIndex
CREATE INDEX "Payment_ownerId_paidAt_idx" ON "Payment"("ownerId", "paidAt");

-- CreateIndex
CREATE INDEX "Payment_repairId_paidAt_idx" ON "Payment"("repairId", "paidAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_ownerId_idempotencyKey_key" ON "Payment"("ownerId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_id_ownerId_key" ON "Payment"("id", "ownerId");

-- CreateIndex
CREATE INDEX "PaymentReversal_paymentId_reversedAt_idx" ON "PaymentReversal"("paymentId", "reversedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentReversal_ownerId_idempotencyKey_key" ON "PaymentReversal"("ownerId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_repairId_key" ON "Invoice"("repairId");

-- CreateIndex
CREATE INDEX "Invoice_ownerId_issuedAt_idx" ON "Invoice"("ownerId", "issuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_ownerId_invoiceCode_key" ON "Invoice"("ownerId", "invoiceCode");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_repairId_ownerId_key" ON "Invoice"("repairId", "ownerId");

-- CreateIndex
CREATE INDEX "RepairStatusHistory_repairId_changedAt_idx" ON "RepairStatusHistory"("repairId", "changedAt");

-- CreateIndex
CREATE INDEX "SyncOperation_ownerId_processedAt_idx" ON "SyncOperation"("ownerId", "processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SyncOperation_ownerId_operationId_key" ON "SyncOperation"("ownerId", "operationId");

-- CreateIndex
CREATE INDEX "AuditEvent_ownerId_createdAt_idx" ON "AuditEvent"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "AuthRateLimit_expiresAt_idx" ON "AuthRateLimit"("expiresAt");

-- AddForeignKey
ALTER TABLE "RefreshSession" ADD CONSTRAINT "RefreshSession_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repair" ADD CONSTRAINT "Repair_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repair" ADD CONSTRAINT "Repair_customerId_ownerId_fkey" FOREIGN KEY ("customerId", "ownerId") REFERENCES "Customer"("id", "ownerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_repairId_ownerId_fkey" FOREIGN KEY ("repairId", "ownerId") REFERENCES "Repair"("id", "ownerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentReversal" ADD CONSTRAINT "PaymentReversal_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentReversal" ADD CONSTRAINT "PaymentReversal_repairId_ownerId_fkey" FOREIGN KEY ("repairId", "ownerId") REFERENCES "Repair"("id", "ownerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentReversal" ADD CONSTRAINT "PaymentReversal_paymentId_ownerId_fkey" FOREIGN KEY ("paymentId", "ownerId") REFERENCES "Payment"("id", "ownerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_repairId_ownerId_fkey" FOREIGN KEY ("repairId", "ownerId") REFERENCES "Repair"("id", "ownerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepairStatusHistory" ADD CONSTRAINT "RepairStatusHistory_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepairStatusHistory" ADD CONSTRAINT "RepairStatusHistory_repairId_ownerId_fkey" FOREIGN KEY ("repairId", "ownerId") REFERENCES "Repair"("id", "ownerId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncOperation" ADD CONSTRAINT "SyncOperation_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE CASCADE ON UPDATE CASCADE;
