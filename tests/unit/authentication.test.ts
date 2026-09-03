// @vitest-environment node
import { UserStatus } from "@prisma/client";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { authenticateWithCredentials } from "@/server/auth/authentication";
import { InvalidCredentialsError, RateLimitedError } from "@/server/auth/errors";
import { hashPassword } from "@/server/auth/password";
import { InMemoryRateLimiter } from "@/server/auth/rate-limit";
import { createMockPrisma, type MockPrisma } from "./helpers/mock-prisma";
import { makeCredentialsUser } from "./helpers/fixtures";

const PASSWORD = "correct-horse-battery-staple";
let passwordHash = "";

beforeAll(async () => {
  passwordHash = await hashPassword(PASSWORD);
});

describe("authenticateWithCredentials", () => {
  let db: MockPrisma;
  let limiter: InMemoryRateLimiter;

  beforeEach(() => {
    db = createMockPrisma();
    limiter = new InMemoryRateLimiter();
  });

  function withUser(overrides = {}) {
    const user = makeCredentialsUser({ email: "kim@example.com", passwordHash, ...overrides });
    db.user.findUnique.mockResolvedValue(user as never);
    return user;
  }

  it("returns the safe user (no passwordHash) on success", async () => {
    withUser();
    const result = await authenticateWithCredentials(
      { email: "kim@example.com", password: PASSWORD },
      { db, limiter },
    );
    expect(result.email).toBe("kim@example.com");
    expect("passwordHash" in result).toBe(false);
    expect(db.auditLog.create).toHaveBeenCalled();
  });

  it("rejects a wrong password with a generic error", async () => {
    withUser();
    await expect(
      authenticateWithCredentials(
        { email: "kim@example.com", password: "wrong-password-here" },
        { db, limiter },
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it("rejects an unknown user with the same generic error (no enumeration)", async () => {
    db.user.findUnique.mockResolvedValue(null);
    await expect(
      authenticateWithCredentials(
        { email: "nobody@example.com", password: PASSWORD },
        { db, limiter },
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it("rejects a disabled account without disclosing that it exists", async () => {
    withUser({ status: UserStatus.SUSPENDED });
    const error = await authenticateWithCredentials(
      { email: "kim@example.com", password: PASSWORD },
      { db, limiter },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(InvalidCredentialsError);
    expect(error.publicMessage).toBe("Invalid email or password.");
  });

  it("enforces a per-identifier rate limit", async () => {
    db.user.findUnique.mockResolvedValue(null);
    for (let i = 0; i < 10; i += 1) {
      await authenticateWithCredentials(
        { email: "spam@example.com", password: "x".repeat(12) },
        { db, limiter },
      ).catch(() => {});
    }
    await expect(
      authenticateWithCredentials(
        { email: "spam@example.com", password: "x".repeat(12) },
        { db, limiter },
      ),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("records an audit event for every failed attempt", async () => {
    withUser();
    await authenticateWithCredentials(
      { email: "kim@example.com", password: "definitely-wrong" },
      { db, limiter },
    ).catch(() => {});
    const actions = db.auditLog.create.mock.calls.map((call) => call[0]?.data?.action);
    expect(actions).toContain("auth.login.failed");
  });
});
