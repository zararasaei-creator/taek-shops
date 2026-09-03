// @vitest-environment node
import { describe, expect, it } from "vitest";

import { WeakPasswordError } from "@/server/auth/errors";
import { hashPassword, needsRehash, verifyPassword } from "@/server/auth/password";

describe("password hashing", () => {
  it("produces an Argon2id PHC hash and never the plaintext", async () => {
    const hash = await hashPassword("a-strong-enough-password");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+\$/);
    expect(hash).not.toContain("a-strong-enough-password");
  });

  it("verifies a correct password", async () => {
    const hash = await hashPassword("roundhouse-kick-42");
    expect(await verifyPassword(hash, "roundhouse-kick-42")).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("roundhouse-kick-42");
    expect(await verifyPassword(hash, "roundhouse-kick-43")).toBe(false);
  });

  it("returns false (never throws) for missing or malformed hashes", async () => {
    expect(await verifyPassword(null, "whatever")).toBe(false);
    expect(await verifyPassword(undefined, "whatever")).toBe(false);
    expect(await verifyPassword("not-a-hash", "whatever")).toBe(false);
  });

  it("enforces the password policy before hashing", async () => {
    await expect(hashPassword("password123")).rejects.toBeInstanceOf(WeakPasswordError);
    await expect(hashPassword("short")).rejects.toBeInstanceOf(WeakPasswordError);
  });

  it("flags hashes weaker than current parameters for rehash", () => {
    expect(needsRehash("$argon2id$v=19$m=4096,t=1,p=1$abc$def")).toBe(true);
    expect(needsRehash("$argon2id$v=19$m=19456,t=2,p=1$abc$def")).toBe(false);
    expect(needsRehash("$2b$12$notargon")).toBe(true);
  });
});
