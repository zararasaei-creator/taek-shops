# Payments (`src/server/domain/payments`)

The provider-agnostic payment boundary (architecture §10). **No card data ever
crosses this boundary** — the browser talks to Stripe directly via the Payment
Element; here we only create/read PaymentIntents and verify webhook signatures.

- **`payment-gateway.ts`** — the `PaymentGateway` interface + typed views:
  `createPaymentIntent`, `retrievePaymentIntent`, `parseWebhook`, `refund`
  (`refund` is a passthrough; its order/inventory side effects are Phase 8).
- **`stripe.ts`** — `StripePaymentGateway`. `createPaymentIntent` always passes a
  per-request `idempotencyKey`; `parseWebhook` uses
  `stripe.webhooks.constructEvent` with `STRIPE_WEBHOOK_SECRET`.
- **`index.ts`** — `getPaymentGateway()` (the swap point) + a test seam.

Orchestration (order ⇄ payment) lives in
[`src/server/orders/payment-service.ts`](../../orders/payment-service.ts):

- `startPayment` — derive the charge amount from the **frozen** `Order.totalCents`
  (never the client), create/reuse **one** `Payment` row + PaymentIntent per
  order.
- `finalizeFromPaymentIntent*` — the single idempotent completion path used by
  BOTH the signature-verified webhook and the server-side return-page check.
  Verifies `pi.amount === order.totalCents` and the currency, then on
  `succeeded` → `Order.paymentStatus = PAID` + `applyOrderStatusTransitionTx(…,
CONFIRMED)` (commits the Phase 5 reservation); on failure/cancel → `FAILED` +
  transition to `CANCELLED` (releases the reservation). Never trusts a browser
  redirect.

Webhook route: [`src/app/api/webhooks/stripe/route.ts`](../../../app/api/webhooks/stripe/route.ts).
Dedup store: the `WebhookEvent` model (`eventId` unique).
