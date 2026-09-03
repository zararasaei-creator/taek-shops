import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Baseline environment for modules that validate config at import time
// (`src/server/config/env.ts`). Individual tests still override via `vi.stubEnv`.
process.env.DATABASE_URL ||= "postgresql://user:pass@localhost:5432/taek_shops_test?schema=public";
process.env.AUTH_SECRET ||= "test-only-secret-value-1234567890";
process.env.NEXT_PUBLIC_APP_URL ||= "http://localhost:3000";

afterEach(() => {
  cleanup();
});
