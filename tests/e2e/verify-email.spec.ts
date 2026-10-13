import { loadEnvFile } from "node:process";
import { randomBytes } from "node:crypto";

import { PrismaClient, UserRole, VerificationPurpose } from "@prisma/client";
import { expect, test } from "@playwright/test";

import { hashPassword } from "@/server/auth/password";
import { createVerificationToken } from "@/server/auth/verification";

/**
 * The email-verification UI (`/verify-email`), against the dedicated e2e
 * server (localhost:3100) and the isolated `TEST_DATABASE_URL`.
 * Self-contained: creates and tears down its own fixtures.
 *
 * Mirrors `password-reset.spec.ts`'s conventions: every token is minted
 * directly via `createVerificationToken` (sidestepping the undelivered-email
 * problem rather than faking a transport) and zero real `/api/auth/login`
 * POSTs (nothing here needs to prove login works). This spec isolates the
 * confirm page's own behaviour; the browser-reachable triggers for the email
 * (self-registration and the authenticated resend control) and the
 * local-preview delivery artifact are covered end to end by
 * `registration.spec.ts`, and the template's own rendering (including that it
 * embeds the raw token) by `tests/unit/mailer-resend.test.ts`'s
 * `ResendMailer — sendEmailVerification`
 * case.
 *
 * The one property unique to this flow, and the main thing this spec
 * exists to prove: loading `/verify-email?token=...` with a GET (what an
 * automated email-link scanner does — many corporate mail gateways
 * prefetch every link in every incoming message) must NOT by itself
 * consume the one-time token. Only clicking the page's explicit "Verify
 * email" button does, via a real `guardMutation`-protected POST.
 */

try {
  loadEnvFile(".env");
} catch {
  // Rely on the ambient environment (CI).
}

const RUN_ID = randomBytes(4).toString("hex");
const USER_EMAIL = `e2e-verifyemail-${RUN_ID}@taek.local`;

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required — see tests/integration/README.md.");
}
const db = new PrismaClient({ datasourceUrl: testDatabaseUrl });

test.beforeAll(async () => {
  const passwordHash = await hashPassword("Some-Password-2026!");
  await db.user.create({
    data: {
      email: USER_EMAIL,
      role: UserRole.CUSTOMER,
      status: "ACTIVE",
      firstName: "E2E",
      lastName: "VerifyEmail",
      emailVerifiedAt: null,
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

test("a GET on the verify-email link never consumes the token; only the explicit confirm click does, and invalid/expired/reused tokens all show the same generic error", async ({
  page,
}) => {
  // --- No token at all: generic error, no confirm button to click ---
  await page.goto("/verify-email");
  await expect(page.getByText(/this link is invalid or has expired/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Verify email" })).toHaveCount(0);

  // --- An invalid (garbage) token: the page itself renders fine (a GET,
  // same as a scanner's prefetch), only the explicit click fails ---
  await page.goto("/verify-email?token=not-a-real-token-at-all-0000000000");
  await expect(page.getByRole("button", { name: "Verify email" })).toBeVisible();
  await page.getByRole("button", { name: "Verify email" }).click();
  await expect(page.getByText(/this link is invalid or has expired/i)).toBeVisible();

  // --- The real token-doesn't-get-consumed-by-GET proof ---
  // Load the confirm page (the GET a scanner would perform) several times
  // WITHOUT ever clicking the button, then navigate away, then come back
  // and actually click. If the mere page load had consumed the token, this
  // final click would fail with the same generic error the invalid-token
  // case above produces — it does not, proving the GET itself never
  // touched `consumeVerificationToken`.
  const scannerSafeToken = await createVerificationToken(
    USER_EMAIL,
    VerificationPurpose.EMAIL_VERIFICATION,
    db,
  );
  for (let i = 0; i < 3; i++) {
    await page.goto(`/verify-email?token=${scannerSafeToken}`);
    await expect(page.getByRole("button", { name: "Verify email" })).toBeVisible();
  }
  await page.goto("/login"); // navigate away entirely, then come back
  await page.goto(`/verify-email?token=${scannerSafeToken}`);
  await page.getByRole("button", { name: "Verify email" }).click();
  await expect(page.getByText(/your email address has been verified/i)).toBeVisible();

  // The DB itself confirms the real effect, not just the UI's message.
  const verifiedUser = await db.user.findUniqueOrThrow({
    where: { email: USER_EMAIL },
    select: { emailVerifiedAt: true },
  });
  expect(verifiedUser.emailVerifiedAt).not.toBeNull();

  // --- Reusing the SAME now-consumed token fails the same generic way ---
  await page.goto(`/verify-email?token=${scannerSafeToken}`);
  await page.getByRole("button", { name: "Verify email" }).click();
  await expect(page.getByText(/this link is invalid or has expired/i)).toBeVisible();

  // --- An expired token shows the SAME generic error, not a different one ---
  const expiredToken = await createVerificationToken(
    USER_EMAIL,
    VerificationPurpose.EMAIL_VERIFICATION,
    db,
  );
  await db.verificationToken.updateMany({
    where: {
      identifier: USER_EMAIL,
      purpose: VerificationPurpose.EMAIL_VERIFICATION,
      consumedAt: null,
    },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  await page.goto(`/verify-email?token=${expiredToken}`);
  await page.getByRole("button", { name: "Verify email" }).click();
  await expect(page.getByText(/this link is invalid or has expired/i)).toBeVisible();
});
