// @vitest-environment node
import { describe, expect, it } from "vitest";

import { registerSchema } from "@/lib/validation/auth";
import { RATE_LIMITS } from "@/server/auth/rate-limit";
import { defaultLanding } from "@/app/login/landing";

describe("registerSchema", () => {
  const valid = { firstName: " Dana ", lastName: "Kim", email: " Dana@Example.COM ", password: "Correct-Horse-9!" };

  it("normalizes and keeps exactly the four accepted fields", () => {
    expect(registerSchema.parse(valid)).toEqual({
      firstName: "Dana",
      lastName: "Kim",
      email: "dana@example.com",
      password: "Correct-Horse-9!",
    });
  });

  it("drops role, status, verification and permission fields rather than passing them on", () => {
    const parsed = registerSchema.parse({
      ...valid,
      role: "ADMIN",
      status: "ACTIVE",
      emailVerifiedAt: "2026-01-01T00:00:00Z",
      permissions: ["user.role.write"],
      id: "x",
    });
    expect(Object.keys(parsed).sort()).toEqual(["email", "firstName", "lastName", "password"]);
  });

  it.each([
    ["empty first name", { firstName: "  " }],
    ["missing last name", { lastName: undefined }],
    ["bad email", { email: "not-an-email" }],
    ["short password", { password: "short" }],
    ["oversized name", { firstName: "x".repeat(101) }],
  ])("rejects %s", (_label, over) => {
    expect(registerSchema.safeParse({ ...valid, ...over }).success).toBe(false);
  });
});

describe("registration policy constants", () => {
  it("rate-limits registration per hour", () => {
    expect(RATE_LIMITS.registration).toEqual({ limit: 10, windowSeconds: 3600 });
  });
  it("lands customers on their account and everyone else on the admin area", () => {
    expect(defaultLanding("CUSTOMER")).toBe("/account");
    expect(defaultLanding("STAFF")).toBe("/admin");
    expect(defaultLanding("ADMIN")).toBe("/admin");
  });
});
