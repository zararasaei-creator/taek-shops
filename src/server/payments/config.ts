import { serverEnv } from "@/server/config/env";

/**
 * Stripe configuration access (Phase 7).
 *
 * Secret keys are server-only env vars (`src/server/config/env.ts`); only
 * `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is ever exposed to the client. Nothing
 * here is logged.
 */

/**
 * Pinned Stripe API version — matches the `stripe` SDK's own pinned version so
 * request/response types line up. Bump deliberately with the SDK, never float.
 */
export const STRIPE_API_VERSION = "2026-08-26.dahlia";

export const PAYMENT_PROVIDER = "stripe";

export function isStripeConfigured(): boolean {
  return Boolean(serverEnv.STRIPE_SECRET_KEY && serverEnv.STRIPE_WEBHOOK_SECRET);
}

export function requireStripeSecretKey(): string {
  const key = serverEnv.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured.");
  return key;
}

export function requireStripeWebhookSecret(): string {
  const secret = serverEnv.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured.");
  return secret;
}
