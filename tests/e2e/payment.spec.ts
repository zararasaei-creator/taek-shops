import { expect, test } from "@playwright/test";

/**
 * Phase 7 payment wiring, verified locally against the running app + live
 * PostgreSQL.
 *
 * The local `.env` holds NON-FUNCTIONAL Stripe placeholders, so the payment
 * *page* (which must create a real PaymentIntent) and the Payment Element cannot
 * be exercised here. The full "enter a Stripe test card → webhook → order paid"
 * e2e requires a Stripe TEST account + test keys + `stripe listen` / CI webhook
 * forwarding — see the Phase 7 report. That server-side path is covered
 * end-to-end by `tests/integration/payments.integration.test.ts` (real webhook
 * route + real DB + real signature verification).
 *
 * What IS locally verifiable: the checkout → payment routing (see
 * `checkout.spec.ts`), the webhook signature gate, and graceful handling of an
 * unknown order.
 */
test("the Stripe webhook endpoint rejects an unsigned / badly-signed request", async ({
  request,
}) => {
  const payload = {
    id: "evt_e2e",
    type: "payment_intent.succeeded",
    data: { object: { id: "pi_e2e" } },
  };

  const unsigned = await request.post("/api/webhooks/stripe", {
    headers: { "content-type": "application/json" },
    data: payload,
  });
  expect(unsigned.status()).toBe(400);
  expect((await unsigned.json()).error).toBe("invalid_signature");

  const badlySigned = await request.post("/api/webhooks/stripe", {
    headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
    data: payload,
  });
  expect(badlySigned.status()).toBe(400);
});

test("the payment page 404s for an unknown order", async ({ page }) => {
  const response = await page.goto("/checkout/TS-00000000-ZZZZZZ/payment");
  expect(response?.status()).toBe(404);
});
