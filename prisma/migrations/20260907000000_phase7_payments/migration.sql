-- Phase 7 — Payments (Stripe).
--
-- 1. `WebhookEvent` — one row per delivered provider event id (`eventId`,
--    unique). The Stripe webhook records the event id inside the same
--    transaction that processes it; a redelivery / replay / duplicate finds the
--    row and is a no-op, and the unique index makes two concurrent deliveries of
--    one event race on the insert so exactly one wins.
-- 2. `Payment.@@unique([orderId])` — one payment record per order, the
--    application-level guard against a duplicate charge. Refunds (Phase 8) mutate
--    this same row rather than inserting another.
--
-- Additive only. No Phase 1-6 model altered. No `Payment` rows exist in any
-- environment yet, so the new unique index applies cleanly.

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_eventId_key" ON "WebhookEvent"("eventId");

-- CreateIndex
CREATE INDEX "WebhookEvent_type_idx" ON "WebhookEvent"("type");

-- CreateIndex
CREATE INDEX "WebhookEvent_receivedAt_idx" ON "WebhookEvent"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_orderId_key" ON "Payment"("orderId");
