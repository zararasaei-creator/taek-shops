// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const VALID_DB_URL = "postgresql://user:pass@localhost:5432/taek_shops?schema=public";

beforeEach(() => {
  // A valid DATABASE_URL is required from Phase 2 onward; provide one by default
  // so individual tests only vary what they are actually asserting.
  vi.stubEnv("DATABASE_URL", VALID_DB_URL);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("environment configuration", () => {
  it("applies safe defaults when optional variables are absent", async () => {
    const { clientEnv, serverEnv } = await import("@/server/config/env");

    expect(clientEnv.NEXT_PUBLIC_APP_URL).toBe("http://localhost:3000");
    expect(serverEnv.IMPORT_MAX_ROW_COUNT).toBe(10_000);
    expect(serverEnv.IMPORT_MAX_FILE_SIZE_BYTES).toBe(5_000_000);
  });

  it("exposes a validated DATABASE_URL", async () => {
    const { serverEnv } = await import("@/server/config/env");
    expect(serverEnv.DATABASE_URL).toBe(VALID_DB_URL);
  });

  it("coerces numeric import limits from strings", async () => {
    vi.stubEnv("IMPORT_MAX_ROW_COUNT", "250");
    vi.resetModules();

    const { serverEnv } = await import("@/server/config/env");
    expect(serverEnv.IMPORT_MAX_ROW_COUNT).toBe(250);
  });

  it("rejects a missing DATABASE_URL", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    vi.resetModules();

    await expect(import("@/server/config/env")).rejects.toThrow(
      /Invalid server environment configuration/,
    );
  });

  it("rejects a malformed URL variable", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "not-a-url");
    vi.resetModules();

    await expect(import("@/server/config/env")).rejects.toThrow(
      /Invalid public environment configuration/,
    );
  });
});
