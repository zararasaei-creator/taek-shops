-- CreateEnum
CREATE TYPE "OrderEmailType" AS ENUM ('ORDER_CONFIRMATION', 'SHIPPING_NOTIFICATION');

-- CreateEnum
CREATE TYPE "OrderEmailStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "OrderEmail" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "type" "OrderEmailType" NOT NULL,
    "status" "OrderEmailStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "claimedBy" TEXT,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderEmail_idempotencyKey_key" ON "OrderEmail"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OrderEmail_status_nextAttemptAt_idx" ON "OrderEmail"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderEmail_orderId_type_key" ON "OrderEmail"("orderId", "type");

-- AddForeignKey
ALTER TABLE "OrderEmail" ADD CONSTRAINT "OrderEmail_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
