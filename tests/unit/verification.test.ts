// @vitest-environment node
import { VerificationPurpose } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  InvalidCredentialsError,
  InvalidTokenError,
  WeakPasswordError,
} from "@/server/auth/errors";
import { hashPassword } from "@/server/auth/password";
import { InMemoryRateLimiter } from "@/server/auth/rate-limit";
import { hashToken } from "@/server/auth/tokens";
import {
  changeOwnPassword,
  completePasswordReset,
  confirmEmailVerification,
  consumeVerificationToken,
  createVerificationToken,
  requestPasswordReset,
} from "@/server/auth/verification";
import { createMockPrisma, type MockPrisma } from "./helpers/mock-prisma";
import { makeCredentialsUser, makeUser } from "./helpers/fixtures";

function capturingMailer() {
  return {
    sendPasswordReset: vi.fn().mockResolvedValue(undefined),
    sendEmailVerification: vi.fn().mockResolvedValue(undefined),
  };
}

describe("verification tokens", () => {
  let db: MockPrisma;

  beforeEach(() => {
    db = createMockPrisma();
    db.verificationToken.deleteMany.mockResolvedValue({ count: 0 } as never);
    db.verificationToken.create.mockResolvedValue({ id: "vt_1" } as never);
    db.verificationToken.update.mockResolvedValue({ id: "vt_1" } as never);
    db.auditLog.create.mockResolvedValue({ id: "a" } as never);
    db.session.deleteMany.mockResolvedValue({ count: 0 } as never);
  });

  it("creates a single-use token and stores only its hash", async () => {
    const raw = await createVerificationToken(
      "Kim@Example.com",
      VerificationPurpose.PASSWORD_RESET,
      db,
    );
    expect(db.verificationToken.deleteMany).toHaveBeenCalled();
    const created = db.verificationToken.create.mock.calls[0]![0].data;
    expect(created.identifier).toBe("kim@example.com");
    expect(created.tokenHash).toBe(hashToken(raw));
    expect(new Date(created.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("consumes a valid token exactly once", async () => {
    const raw = await createVerificationToken(
      "kim@example.com",
      VerificationPurpose.PASSWORD_RESET,
      db,
    );
    db.verificationToken.findUnique.mockResolvedValue({
      id: "vt_1",
      identifier: "kim@example.com",
      purpose: VerificationPurpose.PASSWORD_RESET,
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      tokenHash: hashToken(raw),
    } as never);

    const identifier = await consumeVerificationToken(raw, VerificationPurpose.PASSWORD_RESET, db);
    expect(identifier).toBe("kim@example.com");
    expect(db.verificationToken.update).toHaveBeenCalledWith({
      where: { id: "vt_1" },
      data: { consumedAt: expect.any(Date) },
    });
  });

  it("rejects expired / wrong-purpose / already-consumed tokens", async () => {
    const base = {
      id: "vt_1",
      identifier: "kim@example.com",
      tokenHash: hashToken("t"),
      purpose: VerificationPurpose.PASSWORD_RESET,
      consumedAt: null as Date | null,
      expiresAt: new Date(Date.now() + 60_000),
    };
    db.verificationToken.findUnique.mockResolvedValueOnce({
      ...base,
      expiresAt: new Date(0),
    } as never);
    await expect(
      consumeVerificationToken("t", VerificationPurpose.PASSWORD_RESET, db),
    ).rejects.toBeInstanceOf(InvalidTokenError);

    db.verificationToken.findUnique.mockResolvedValueOnce({
      ...base,
      consumedAt: new Date(),
    } as never);
    await expect(
      consumeVerificationToken("t", VerificationPurpose.PASSWORD_RESET, db),
    ).rejects.toBeInstanceOf(InvalidTokenError);

    db.verificationToken.findUnique.mockResolvedValueOnce({
      ...base,
      purpose: VerificationPurpose.EMAIL_VERIFICATION,
    } as never);
    await expect(
      consumeVerificationToken("t", VerificationPurpose.PASSWORD_RESET, db),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });
});

describe("password reset flow", () => {
  let db: MockPrisma;

  beforeEach(() => {
    db = createMockPrisma();
    db.verificationToken.deleteMany.mockResolvedValue({ count: 0 } as never);
    db.verificationToken.create.mockResolvedValue({ id: "vt_1" } as never);
    db.verificationToken.update.mockResolvedValue({ id: "vt_1" } as never);
    db.auditLog.create.mockResolvedValue({ id: "a" } as never);
    db.session.deleteMany.mockResolvedValue({ count: 2 } as never);
    db.user.update.mockResolvedValue({} as never);
  });

  it("does not reveal whether the email exists, but still audits", async () => {
    db.user.findUnique.mockResolvedValue(null);
    const mailer = capturingMailer();
    await expect(
      requestPasswordReset(
        { email: "ghost@example.com" },
        { db, mailer, limiter: new InMemoryRateLimiter() },
      ),
    ).resolves.toBeUndefined();
    expect(mailer.sendPasswordReset).not.toHaveBeenCalled();
    expect(db.auditLog.create).toHaveBeenCalled();
  });

  it("emails a token when the user exists", async () => {
    db.user.findUnique.mockResolvedValue(makeUser({ email: "real@example.com" }) as never);
    const mailer = capturingMailer();
    await requestPasswordReset(
      { email: "real@example.com" },
      { db, mailer, limiter: new InMemoryRateLimiter() },
    );
    expect(mailer.sendPasswordReset).toHaveBeenCalledOnce();
    const arg = mailer.sendPasswordReset.mock.calls[0]![0];
    expect(arg.to).toBe("real@example.com");
    expect(typeof arg.token).toBe("string");
  });

  it("completing a reset re-hashes the password and revokes all sessions", async () => {
    const user = makeUser({ id: "user_9", email: "real@example.com" });
    db.verificationToken.findUnique.mockResolvedValue({
      id: "vt_1",
      identifier: "real@example.com",
      purpose: VerificationPurpose.PASSWORD_RESET,
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      tokenHash: "x",
    } as never);
    db.user.findUnique.mockResolvedValue(user as never);

    await completePasswordReset({ token: "raw", password: "brand-new-strong-password" }, { db });

    expect(db.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "user_9" },
        data: { passwordHash: expect.any(String) },
      }),
    );
    expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { userId: "user_9" } });
    const audit = db.auditLog.create.mock.calls.at(-1)?.[0]?.data;
    expect(audit?.action).toBe("auth.password.reset_completed");
  });

  it("rejects a weak new password", async () => {
    db.verificationToken.findUnique.mockResolvedValue({
      id: "vt_1",
      identifier: "real@example.com",
      purpose: VerificationPurpose.PASSWORD_RESET,
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      tokenHash: "x",
    } as never);
    db.user.findUnique.mockResolvedValue(makeUser({ email: "real@example.com" }) as never);
    await expect(
      completePasswordReset({ token: "raw", password: "password123" }, { db }),
    ).rejects.toBeInstanceOf(WeakPasswordError);
  });
});

describe("email verification + self-service password change", () => {
  let db: MockPrisma;

  beforeEach(() => {
    db = createMockPrisma();
    db.verificationToken.update.mockResolvedValue({ id: "vt" } as never);
    db.auditLog.create.mockResolvedValue({ id: "a" } as never);
    db.user.update.mockResolvedValue({} as never);
  });

  it("confirmEmailVerification marks the user verified", async () => {
    db.verificationToken.findUnique.mockResolvedValue({
      id: "vt",
      identifier: "v@example.com",
      purpose: VerificationPurpose.EMAIL_VERIFICATION,
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      tokenHash: "x",
    } as never);
    db.user.findUnique.mockResolvedValue(makeUser({ id: "u", email: "v@example.com" }) as never);

    await confirmEmailVerification({ token: "raw" }, { db });
    expect(db.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u" }, data: { emailVerifiedAt: expect.any(Date) } }),
    );
  });

  it("changeOwnPassword requires the correct current password", async () => {
    const hash = await hashPassword("current-password-ok");
    db.user.findUnique.mockResolvedValue(
      makeCredentialsUser({ id: "u", email: "v@example.com", passwordHash: hash }) as never,
    );

    await expect(
      changeOwnPassword(
        { userId: "u", currentPassword: "wrong", newPassword: "another-strong-one" },
        { db },
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);

    await changeOwnPassword(
      { userId: "u", currentPassword: "current-password-ok", newPassword: "another-strong-one" },
      { db },
    );
    const audit = db.auditLog.create.mock.calls.at(-1)?.[0]?.data;
    expect(audit?.action).toBe("auth.password.changed");
  });
});
