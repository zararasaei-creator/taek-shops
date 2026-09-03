import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Baseline environment for modules that validate config at import time
// (`src/server/config/env.ts`). Individual tests still override via `vi.stubEnv`.
process.env.DATABASE_URL ||= "postgresql://user:pass@localhost:5432/taek_shops_test?schema=public";
process.env.AUTH_SECRET ||= "test-only-secret-value-1234567890";
process.env.NEXT_PUBLIC_APP_URL ||= "http://localhost:3000";
// Non-functional Stripe placeholders so payment/webhook modules import cleanly.
// Every unit test that exercises Stripe mocks the SDK; these are never used to
// call Stripe.
process.env.STRIPE_SECRET_KEY ||= "sk_test_unit_placeholder";
process.env.STRIPE_WEBHOOK_SECRET ||= "whsec_unit_placeholder";
process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ||= "pk_test_unit_placeholder";

afterEach(() => {
  cleanup();
});
