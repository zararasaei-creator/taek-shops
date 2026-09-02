// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

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

  it("coerces numeric import limits from strings", async () => {
    vi.stubEnv("IMPORT_MAX_ROW_COUNT", "250");
    vi.resetModules();

    const { serverEnv } = await import("@/server/config/env");
    expect(serverEnv.IMPORT_MAX_ROW_COUNT).toBe(250);
  });

  it("rejects a malformed URL variable", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "not-a-url");
    vi.resetModules();

    await expect(import("@/server/config/env")).rejects.toThrow(
      /Invalid public environment configuration/,
    );
  });
});
