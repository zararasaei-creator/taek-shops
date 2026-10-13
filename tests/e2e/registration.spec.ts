import { loadEnvFile } from "node:process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";

import { E2E_PRODUCT_SLUG } from "./global-setup";
import { listEmailPreviewFiles, newPreviewFilesOfType } from "./helpers/email-previews";
import { loginAs } from "./helpers/login";

/**
 * Customer self-registration through the real browser UI, against the dedicated
 * e2e server (localhost:3100) and the isolated `TEST_DATABASE_URL`. Email goes
 * to the e2e server's LOCAL-PREVIEW transport (a file under
 * `.local/email-previews/` — nothing is sent anywhere); the test reads that file
 * to obtain the verification link, which is exactly the "fake delivery" a human
 * reviewer would use. Serial: the preview directory is shared, so each step
 * diffs it before/after.
 */

try {
  loadEnvFile(".env");
} catch {
  // Rely on the ambient environment (CI).
}

const RUN = randomBytes(4).toString("hex");
const PASSWORD = "Correct-Horse-Battery-9!";
const emailFor = (label: string) => `e2e-reg-${RUN}-${label}@taek.local`;

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required — see tests/integration/README.md.");
}
const db = new PrismaClient({ datasourceUrl: testDatabaseUrl });

test.describe.configure({ mode: "serial" });

// The server's rate limiter keys on client IP. A per-run documentation-range
// address keeps this spec's registrations/resends (5 verification requests —
// the per-hour limit) isolated from every other spec and from earlier runs.
test.use({
  extraHTTPHeaders: {
    "x-forwarded-for": `198.51.100.${(parseInt(RUN.slice(0, 2), 16) % 250) + 1}`,
  },
});

test.afterAll(async () => {
  const prefix = `e2e-reg-${RUN}-`;
  const users = await db.user.findMany({ where: { email: { startsWith: prefix } }, select: { id: true } });
  const orders = await db.order.findMany({
    where: { OR: [{ customerEmail: { startsWith: prefix } }, { userId: { in: users.map((u) => u.id) } }] },
    select: { id: true },
  });
  await db.auditLog.deleteMany({
    where: {
      OR: [
        { actorUserId: { in: users.map((u) => u.id) } },
        { entityId: { in: orders.map((o) => o.id) } },
        { metadata: { path: ["email"], string_starts_with: prefix } },
      ],
    },
  });
  await db.order.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } });
  await db.verificationToken.deleteMany({ where: { identifier: { startsWith: prefix } } });
  await db.user.deleteMany({ where: { email: { startsWith: prefix } } });
  await db.$disconnect();
});

async function register(page: Page, email: string, over: { password?: string } = {}) {
  await page.goto("/register");
  await page.getByLabel("First name").fill("Dana");
  await page.getByLabel("Last name").fill("Kim");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(over.password ?? PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
}

/** The verification link inside the newest local-preview email of that type. */
async function newVerificationLink(before: Set<string>): Promise<string> {
  await expect
    .poll(async () => newPreviewFilesOfType(before, await listEmailPreviewFiles(), "email-verification").length, {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);
  const files = newPreviewFilesOfType(before, await listEmailPreviewFiles(), "email-verification")
    .filter((f) => f.endsWith(".txt"))
    .sort();
  const text = await readFile(join(process.cwd(), ".local", "email-previews", files.at(-1)!), "utf8");
  const match = text.match(/https?:\/\/\S+\/verify-email\?token=\S+/);
  expect(match, "verification link present in the preview email").not.toBeNull();
  const url = new URL(match![0]);
  return `${url.pathname}${url.search}`;
}

test("a visitor finds Create account, registers, verifies via the emailed link (explicit click), signs in, and reaches the account page", async ({
  page,
}) => {
  const email = emailFor("flow");

  // Entry points: header (logged out) and the login page.
  await page.goto("/");
  await expect(page.getByTestId("nav-create-account")).toBeVisible();
  await page.goto("/login");
  await expect(page.getByTestId("login-create-account")).toBeVisible();

  const before = await listEmailPreviewFiles();
  await register(page, email);
  await expect(page.getByTestId("register-done")).toContainText(/if that email can be used/i);
  // It does not claim an email was delivered.
  await expect(page.getByTestId("register-done")).not.toContainText(/we('|’)ve sent/i);

  const user = await db.user.findUniqueOrThrow({ where: { email } });
  expect(user).toMatchObject({ role: "CUSTOMER", status: "ACTIVE", emailVerifiedAt: null });

  // Fake/local delivery → explicit verification (GET alone does nothing).
  const link = await newVerificationLink(before);
  await page.goto(link);
  expect((await db.user.findUniqueOrThrow({ where: { email } })).emailVerifiedAt).toBeNull();
  await page.getByRole("button", { name: "Verify email" }).click();
  await expect(page.getByText(/your email address has been verified/i)).toBeVisible();
  expect((await db.user.findUniqueOrThrow({ where: { email } })).emailVerifiedAt).not.toBeNull();

  // Sign in → lands on the customer account page (not /admin).
  await loginAs(page, email, PASSWORD, "/account");
  await expect(page.getByRole("heading", { level: 1, name: "Your account" })).toBeVisible();
  await expect(page.getByTestId("account-email")).toHaveText(email);
  await expect(page.getByTestId("account-verification")).toHaveText("Verified");
  await expect(page.getByTestId("nav-account")).toBeVisible();

  // A customer is not staff.
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
  await expect(page.getByText(/application error|something went wrong/i)).toHaveCount(0);
  await expect(page.getByRole("link", { name: /orders|catalog|users/i }).filter({ hasText: /^(Orders|Catalog|Users)$/ })).toHaveCount(0);
});

test("registering an existing email looks identical, sends no email, and never changes the existing account", async ({
  page,
}) => {
  const email = emailFor("dup");
  await register(page, email);
  await expect(page.getByTestId("register-done")).toBeVisible();
  const original = await db.user.findUniqueOrThrow({ where: { email } });

  const before = await listEmailPreviewFiles();
  await page.goto("/register");
  await page.getByLabel("First name").fill("Someone");
  await page.getByLabel("Last name").fill("Else");
  await page.getByLabel("Email").fill(email.toUpperCase());
  await page.getByLabel("Password").fill("Another-Zebra-Pass-44!");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByTestId("register-done")).toContainText(/if that email can be used/i);

  const after = await db.user.findUniqueOrThrow({ where: { email } });
  expect(after.passwordHash).toBe(original.passwordHash);
  expect(after.firstName).toBe("Dana");
  expect(await db.user.count({ where: { email } })).toBe(1);
  await page.waitForTimeout(500);
  expect(newPreviewFilesOfType(before, await listEmailPreviewFiles(), "email-verification")).toHaveLength(0);
});

test("a tampered registration request (role, status, verification) is ignored by the real endpoint", async ({
  page,
}) => {
  const email = emailFor("tamper");
  await page.goto("/register");
  const status = await page.evaluate(
    async ({ email, password }) => {
      const { csrfToken } = (await (await fetch("/api/auth/session", { cache: "no-store" })).json()) as {
        csrfToken: string;
      };
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({
          firstName: "Eve",
          lastName: "Mallory",
          email,
          password,
          role: "ADMIN",
          status: "DISABLED",
          emailVerifiedAt: new Date().toISOString(),
          permissions: ["user.role.write"],
        }),
      });
      return response.status;
    },
    { email, password: PASSWORD },
  );
  expect(status).toBe(200);
  expect(await db.user.findUniqueOrThrow({ where: { email } })).toMatchObject({
    role: "CUSTOMER",
    status: "ACTIVE",
    emailVerifiedAt: null,
  });
});

test("a weak password is refused with a clear message and creates no account", async ({ page }) => {
  const email = emailFor("weak");
  await register(page, email, { password: "short" });
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByTestId("register-done")).toHaveCount(0);
  expect(await db.user.count({ where: { email } })).toBe(0);
});

test("an unverified customer can sign in, resend the verification email from their account, and place an order that appears only in their history", async ({
  page,
}) => {
  const email = emailFor("order");
  await register(page, email);
  await expect(page.getByTestId("register-done")).toBeVisible();

  await loginAs(page, email, PASSWORD, "/account");
  await expect(page.getByTestId("account-verification")).toHaveText("Not verified yet");

  // Resend (authenticated, rate-limited endpoint) → a NEW local preview email.
  const before = await listEmailPreviewFiles();
  await page.getByRole("button", { name: "Resend verification email" }).click();
  await expect(page.getByTestId("resend-message")).toContainText(/requested/i);
  await expect(page.getByTestId("resend-message")).not.toContainText(/delivered/i);
  const link = await newVerificationLink(before);
  expect(link).toContain("/verify-email?token=");

  // Unverified customers can still shop and check out; the order is theirs.
  await page.goto(`/products/${E2E_PRODUCT_SLUG}`);
  await page.getByRole("button", { name: "Add to cart" }).first().click();
  await expect(page.getByTestId("nav-cart")).toHaveText("Cart (1)");
  await page.goto("/cart");
  await page.getByTestId("to-checkout").click();
  await expect(page).toHaveURL(/\/checkout$/);
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="firstName"]').fill("Dana");
  await page.locator('input[name="lastName"]').fill("Kim");
  await page.locator('input[name="line1"]').fill("10 Dojang Rd");
  await page.locator('input[name="city"]').fill("Toronto");
  await page.locator('select[name="province"]').selectOption("ON");
  await page.locator('input[name="postalCode"]').fill("M5V 2T6");
  await page.getByRole("radio").first().check();
  await page.getByRole("button", { name: "Place order" }).click();
  await expect(page).toHaveURL(/\/checkout\/TS-\d{8}-[0-9A-Z]{6}\/payment$/);
  const orderNumber = new URL(page.url()).pathname.split("/")[2]!;

  const owner = await db.user.findUniqueOrThrow({ where: { email } });
  expect((await db.order.findUniqueOrThrow({ where: { orderNumber } })).userId).toBe(owner.id);

  await page.goto("/account/orders");
  await expect(page.getByRole("link", { name: orderNumber })).toBeVisible();
});
