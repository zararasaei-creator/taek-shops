// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/taek_shops?schema=public");
  vi.stubEnv("NODE_ENV", "test");
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("prisma client singleton", () => {
  it("exports a client instance with model accessors", async () => {
    const { prisma } = await import("@/server/db/client");
    expect(prisma).toBeDefined();
    expect(typeof prisma.product.findMany).toBe("function");
    expect(typeof prisma.$transaction).toBe("function");
    await prisma.$disconnect();
  });

  it("returns the same instance when re-imported (no reset)", async () => {
    const first = (await import("@/server/db/client")).prisma;
    const second = (await import("@/server/db/client")).prisma;
    expect(first).toBe(second);
    await first.$disconnect();
  });
});
