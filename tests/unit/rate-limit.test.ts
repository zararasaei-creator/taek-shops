// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryRateLimiter, enforceRateLimit } from "@/server/auth/rate-limit";

describe("InMemoryRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows up to the limit then blocks with a retry hint", async () => {
    const limiter = new InMemoryRateLimiter();
    for (let i = 0; i < 3; i += 1) {
      const result = await limiter.consume("k", 3, 60);
      expect(result.allowed).toBe(true);
    }
    const blocked = await limiter.consume("k", 3, 60);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("resets after the window elapses", async () => {
    const limiter = new InMemoryRateLimiter();
    await limiter.consume("k", 1, 60);
    expect((await limiter.consume("k", 1, 60)).allowed).toBe(false);
    vi.advanceTimersByTime(61_000);
    expect((await limiter.consume("k", 1, 60)).allowed).toBe(true);
  });

  it("keys are independent and reset() clears one", async () => {
    const limiter = new InMemoryRateLimiter();
    await limiter.consume("a", 1, 60);
    expect((await limiter.consume("b", 1, 60)).allowed).toBe(true);
    await limiter.reset("a");
    expect((await limiter.consume("a", 1, 60)).allowed).toBe(true);
  });

  it("enforceRateLimit applies the login policy", async () => {
    const limiter = new InMemoryRateLimiter();
    let last = await enforceRateLimit("login", "ip:1.2.3.4", limiter);
    for (let i = 0; i < 12; i += 1) {
      last = await enforceRateLimit("login", "ip:1.2.3.4", limiter);
    }
    expect(last.allowed).toBe(false);
  });
});
