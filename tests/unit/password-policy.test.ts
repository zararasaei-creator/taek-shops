// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  PASSWORD_MIN_LENGTH,
  isPasswordAcceptable,
  validatePassword,
} from "@/server/auth/password-policy";

describe("password policy", () => {
  it("accepts a reasonable passphrase", () => {
    expect(validatePassword("correct-horse-battery-staple")).toEqual([]);
    expect(isPasswordAcceptable("Tornado-Kick-2026!")).toBe(true);
  });

  it("rejects passwords shorter than the minimum", () => {
    const reasons = validatePassword("short1");
    expect(reasons.some((r) => r.includes(String(PASSWORD_MIN_LENGTH)))).toBe(true);
  });

  it("rejects overly long passwords", () => {
    expect(validatePassword("a".repeat(200))).toContain("Must be at most 128 characters.");
  });

  it("rejects common passwords regardless of case", () => {
    expect(validatePassword("Password123")).toContain("This password is too common.");
    expect(validatePassword("TAEKWONDO")).toContain("This password is too common.");
  });

  it("rejects low-entropy repeated characters", () => {
    expect(validatePassword("aaaaaaaaaaaa")).not.toEqual([]);
  });

  it("rejects passwords containing the user's email local-part or name", () => {
    expect(
      validatePassword("gordonRamsay99xx", { email: "gordon@example.com", firstName: "Gordon" }),
    ).toContain("Must not contain your name or email.");
    expect(validatePassword("my-gordon-login-1", { email: "gordon@example.com" })).toEqual(
      expect.arrayContaining(["Must not contain your name or email."]),
    );
    // The shared email *domain* is not treated as personal information.
    expect(validatePassword("example-domain-xyz", { email: "gordon@example.com" })).toEqual([]);
  });

  it("rejects leading/trailing whitespace", () => {
    expect(validatePassword(" longenoughpwd ")).toContain("Must not start or end with whitespace.");
  });

  it("tolerates null context fields", () => {
    expect(validatePassword("a-good-long-password", { firstName: null, lastName: null })).toEqual(
      [],
    );
  });
});
