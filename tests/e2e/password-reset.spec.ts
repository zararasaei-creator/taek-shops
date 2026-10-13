import { loadEnvFile } from "node:process";
import { randomBytes } from "node:crypto";

import { PrismaClient, UserRole, VerificationPurpose } from "@prisma/client";
import { expect, test } from "@playwright/test";

import { hashPassword, verifyPassword } from "@/server/auth/password";
import { createVerificationToken } from "@/server/auth/verification";
import { listEmailPreviewFiles, newPreviewFilesOfType } from "./helpers/email-previews";

/**
 * Phase "launch prep" — the password-reset UI (`/password-reset`,
 * `/password-reset/confirm`), against the dedicated e2e server
 * (localhost:3100) and the isolated `TEST_DATABASE_URL`. Self-contained:
 * creates and tears down its own fixtures.
 *
 * The token lifecycle itself (expiry, single-use, wrong-purpose, weak
 * password, session revocation, no-enumeration) is already thoroughly
 * unit-tested against mocked Prisma in `tests/unit/verification.test.ts`.
 * This spec instead proves the NEW pieces: the actual pages render and
 * link correctly, and a real browser round trip through the real
 * `guardMutation`/CSRF-protected routes works end to end.
 *
 * No real email transport exists for auth yet (`src/server/auth/mailer.ts`
 * is `NoopMailer` — see the roadmap's "Not claimed" note) and this spec
 * does not add one: every token here is minted directly via
 * `createVerificationToken`, the exact same function
 * `requestPasswordReset` itself calls right before handing the token to
 * the (never exercised here) mailer. This sidesteps the mailer entirely
 * rather than faking a transport that doesn't exist in production.
 *
 * This spec makes ZERO real `/api/auth/login` POSTs — login itself is
 * already covered elsewhere (`auth.spec.ts`, `admin-orders.spec.ts`, etc.),
 * all sharing one IP-keyed, time-windowed rate limit across the whole e2e
 * suite (see those specs' comments on that budget — exceeding it once
 * already broke an unrelated spec's login earlier in this project's
 * history, and the fix was always to reduce usage, never touch the
 * limiter). The final assertion instead verifies the reset genuinely
 * updated the stored password hash directly, which proves the same thing
 * without spending any of that shared budget.
 */

try {
  loadEnvFile(".env");
} catch {
  // Rely on the ambient environment (CI).
}

const RUN_ID = randomBytes(4).toString("hex");
const USER_EMAIL = `e2e-pwreset-${RUN_ID}@taek.local`;
const ORIGINAL_PASSWORD = "Original-Password-2026!";
const NEW_PASSWORD = "Brand-New-Password-2026!";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required — see tests/integration/README.md.");
}
const db = new PrismaClient({ datasourceUrl: testDatabaseUrl });

test.beforeAll(async () => {
  const passwordHash = await hashPassword(ORIGINAL_PASSWORD);
  await db.user.create({
    data: {
      email: USER_EMAIL,
      role: UserRole.CUSTOMER,
      status: "ACTIVE",
      firstName: "E2E",
      lastName: "PasswordReset",
      emailVerifiedAt: new Date(),
      passwordHash,
    },
  });
});

test.afterAll(async () => {
  await db.verificationToken.deleteMany({ where: { identifier: USER_EMAIL } });
  const actor = await db.user.findUnique({ where: { email: USER_EMAIL }, select: { id: true } });
  if (actor) await db.auditLog.deleteMany({ where: { actorUserId: actor.id } });
  await db.user.deleteMany({ where: { email: USER_EMAIL } });
  await db.$disconnect();
});

test("the login page links to password reset, the request form never reveals account existence, and a real reset round trip through the UI works", async ({
  page,
}) => {
  // --- The login page links to the reset flow ---
  await page.goto("/login");
  const forgotLink = page.getByRole("link", { name: "Forgot password?" });
  await expect(forgotLink).toBeVisible();
  await forgotLink.click();
  await page.waitForURL(/\/password-reset$/);

  // --- Requesting a reset for an UNKNOWN email shows the generic message ---
  // AND produces no delivery artifact at all — the generic UI message is
  // identical either way, so the message alone proves nothing about what
  // the backend actually did; the filesystem check below is what does.
  const beforeUnknown = await listEmailPreviewFiles();
  await page.getByLabel("Email").fill(`e2e-pwreset-unknown-${RUN_ID}@taek.local`);
  await page.getByRole("button", { name: "Send reset link" }).click();
  const genericMessage = page.getByText(/we've sent a link to reset the password/i);
  await expect(genericMessage).toBeVisible();
  const afterUnknown = await listEmailPreviewFiles();
  expect(newPreviewFilesOfType(beforeUnknown, afterUnknown, "password-reset")).toHaveLength(0);

  // --- Requesting a reset for the REAL email shows the exact same message
  // --- BUT this time a real delivery artifact IS produced. This is the
  // check that would have caught the EMAIL_TRANSPORT fail-closed bug found
  // earlier in this project's own history, where the local-preview
  // transport threw in the e2e server and the request actually failed —
  // invisible to a test that only checks the UI's (deliberately
  // enumeration-safe, always-the-same) message.
  // A fresh page load, not reusing the "unknown" submission's state, so
  // this is a genuinely separate request, not cached UI state.
  await page.goto("/password-reset");
  const beforeReal = await listEmailPreviewFiles();
  await page.getByLabel("Email").fill(USER_EMAIL);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(genericMessage).toBeVisible();
  const afterReal = await listEmailPreviewFiles();
  const realDeliveryFiles = newPreviewFilesOfType(beforeReal, afterReal, "password-reset");
  expect(realDeliveryFiles.length).toBeGreaterThan(0);

  // --- An invalid (garbage) token shows the generic invalid/expired error ---
  await page.goto("/password-reset/confirm?token=not-a-real-token-at-all-0000000000");
  await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByText(/this link is invalid or has expired/i)).toBeVisible();

  // --- An expired token shows the SAME generic error, not a different one ---
  // (proving the UI never distinguishes "expired" from "invalid" — matching
  // the server's own `InvalidTokenError`, used for both)
  const expiredToken = await createVerificationToken(USER_EMAIL, VerificationPurpose.PASSWORD_RESET, db);
  await db.verificationToken.updateMany({
    where: { identifier: USER_EMAIL, purpose: VerificationPurpose.PASSWORD_RESET, consumedAt: null },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  await page.goto(`/password-reset/confirm?token=${expiredToken}`);
  await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByText(/this link is invalid or has expired/i)).toBeVisible();

  // --- A weak password is rejected with specific reasons, token still valid ---
  const validToken = await createVerificationToken(USER_EMAIL, VerificationPurpose.PASSWORD_RESET, db);
  await page.goto(`/password-reset/confirm?token=${validToken}`);
  await page.getByLabel("New password", { exact: true }).fill("short1");
  await page.getByLabel("Confirm new password").fill("short1");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByText(/at least 10 characters/i)).toBeVisible();

  // --- Mismatched confirmation is caught client-side, before any request ---
  await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Confirm new password").fill("DoesNotMatch123!");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByText(/passwords do not match/i)).toBeVisible();

  // --- The real, successful reset ---
  await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByText(/your password has been reset/i)).toBeVisible();

  // --- Reusing the SAME now-consumed token fails the same generic way ---
  await page.goto(`/password-reset/confirm?token=${validToken}`);
  await page.getByLabel("New password", { exact: true }).fill("Another-Attempt-2026!");
  await page.getByLabel("Confirm new password").fill("Another-Attempt-2026!");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByText(/this link is invalid or has expired/i)).toBeVisible();

  // --- The reset genuinely set the new password ---
  // Verified directly against the stored hash rather than a real
  // `/api/auth/login` POST through the browser: login itself is already
  // covered elsewhere (`auth.spec.ts`, `admin-orders.spec.ts`, etc.) and
  // shares one IP-keyed rate-limit budget across the whole e2e suite (see
  // those specs' own comments on it) — this spec's job is to prove the
  // RESET set the right password, which a direct hash check proves just as
  // well without spending any of that shared budget.
  const updatedUser = await db.user.findUniqueOrThrow({
    where: { email: USER_EMAIL },
    select: { passwordHash: true },
  });
  expect(await verifyPassword(updatedUser.passwordHash, NEW_PASSWORD)).toBe(true);
  expect(await verifyPassword(updatedUser.passwordHash, ORIGINAL_PASSWORD)).toBe(false);
});
