import { randomBytes } from "node:crypto";

import { UserRole, UserStatus } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { BootstrapRefusedError, bootstrapFirstAdmin } from "@/server/auth/bootstrap-admin";
import { authenticateWithCredentials } from "@/server/auth/authentication";
import { InvalidCredentialsError, WeakPasswordError } from "@/server/auth/errors";
import { hashPassword } from "@/server/auth/password";
import { InMemoryRateLimiter } from "@/server/auth/rate-limit";
import { __setMailer } from "@/server/auth/mailer";
import { db } from "./helpers/db";
import { FakeMailer } from "./helpers/auth-mailer";

/**
 * First-ADMIN bootstrap against the isolated test database (real Prisma, real
 * Argon2id, the real auth service for sign-in; fake mailer). The test database must
 * hold no ADMIN at the start — other suites create and remove their own. Every row
 * this file creates is namespaced by `PREFIX` and removed after each test.
 */

const RUN = randomBytes(4).toString("hex");
const PREFIX = `boot-${RUN}-`;
const PASSWORD = "Correct-Horse-Battery-9!";
let seq = 0;
const email = (label = "admin") => `${PREFIX}${label}${(seq += 1)}@taek.local`;
const limiter = () => new InMemoryRateLimiter();

const BUSINESS_TABLES = {
  product: () => db.product.count(),
  variant: () => db.productVariant.count(),
  brand: () => db.brand.count(),
  category: () => db.category.count(),
  inventoryItem: () => db.inventoryItem.count(),
  taxRegion: () => db.taxRegion.count(),
  taxRate: () => db.taxRate.count(),
  shippingZone: () => db.shippingZone.count(),
  shippingMethod: () => db.shippingMethod.count(),
  order: () => db.order.count(),
  cart: () => db.cart.count(),
  discount: () => db.discount.count(),
  importJob: () => db.importJob.count(),
};
async function snapshot() {
  const out: Record<string, number> = {};
  for (const [name, count] of Object.entries(BUSINESS_TABLES)) out[name] = await count();
  return out;
}

async function wipe() {
  const users = await db.user.findMany({ where: { email: { startsWith: PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await db.auditLog.deleteMany({ where: { OR: [{ entityId: { in: ids } }, { actorUserId: { in: ids } }] } });
  await db.session.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

let mailer: FakeMailer;

beforeAll(async () => {
  const existing = await db.user.count({ where: { role: UserRole.ADMIN } });
  if (existing > 0) {
    throw new Error(`Test database already has ${existing} ADMIN user(s); this suite needs a clean slate.`);
  }
  mailer = new FakeMailer();
  __setMailer(mailer);
});
afterEach(wipe);
afterAll(async () => {
  await wipe();
  await db.$disconnect();
});

describe("successful bootstrap", () => {
  it("creates one ACTIVE, unverified ADMIN who can sign in through the real auth service — and nothing else", async () => {
    const before = await snapshot();
    const users = await db.user.count();
    const e = email();

    const admin = await bootstrapFirstAdmin({ email: ` ${e.toUpperCase()} `, password: PASSWORD, firstName: " Ada ", lastName: "Min" });

    expect(admin).toMatchObject({
      email: e, // normalized
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
      emailVerifiedAt: null, // never falsely verified
      firstName: "Ada",
      lastName: "Min",
    });
    const row = await db.user.findUniqueOrThrow({ where: { email: e }, select: { passwordHash: true } });
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row.passwordHash).not.toContain(PASSWORD);

    // Real sign-in: right password works, wrong one doesn't.
    await expect(authenticateWithCredentials({ email: e, password: PASSWORD }, { limiter: limiter() })).resolves.toMatchObject({
      id: admin.id,
      role: UserRole.ADMIN,
    });
    await expect(authenticateWithCredentials({ email: e, password: PASSWORD + "x" }, { limiter: limiter() })).rejects.toBeInstanceOf(
      InvalidCredentialsError,
    );

    // Exactly one new user; no sample/business data; no email sent.
    expect(await db.user.count()).toBe(users + 1);
    expect(await snapshot()).toEqual(before);
    expect(mailer.emailVerificationCalls).toHaveLength(0);
    expect(mailer.passwordResetCalls).toHaveLength(0);
  });

  it("records an audit event without any secret", async () => {
    const admin = await bootstrapFirstAdmin({ email: email(), password: PASSWORD });
    const rows = await db.auditLog.findMany({ where: { action: "auth.admin.bootstrapped", entityId: admin.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: "User", actorUserId: null });
    const text = JSON.stringify(rows[0]);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toMatch(/argon2|passwordHash|password/i);
    expect(rows[0]!.metadata).toMatchObject({ role: "ADMIN", status: "ACTIVE", emailVerified: false, via: "cli" });
  });
});

describe("refusals change nothing", () => {
  it("refuses once an ADMIN exists (rerun is safe; the existing admin is untouched)", async () => {
    const first = await bootstrapFirstAdmin({ email: email(), password: PASSWORD });
    const before = await db.user.findUniqueOrThrow({ where: { id: first.id } });
    const users = await db.user.count();

    // Same email again, and a different email: both refused as "admin_exists".
    for (const e of [first.email, email()]) {
      const err = await bootstrapFirstAdmin({ email: e, password: "Another-Strong-Pass-77!" }).catch((x: unknown) => x);
      expect(err).toBeInstanceOf(BootstrapRefusedError);
      expect((err as BootstrapRefusedError).code).toBe("admin_exists");
    }
    expect(await db.user.count()).toBe(users);
    expect(await db.user.findUniqueOrThrow({ where: { id: first.id } })).toEqual(before); // incl. passwordHash, updatedAt
  });

  it("refuses an email that already belongs to ANY account — customer, staff — never promoting or overwriting it", async () => {
    for (const role of [UserRole.CUSTOMER, UserRole.STAFF]) {
      const e = email(role.toLowerCase());
      const hash = await hashPassword("Original-Account-Pass-31!");
      await db.user.create({
        data: { email: e, role, status: UserStatus.ACTIVE, firstName: "Keep", lastName: "Me", passwordHash: hash },
      });
      const before = await db.user.findUniqueOrThrow({ where: { email: e } });

      const err = await bootstrapFirstAdmin({ email: e, password: PASSWORD, firstName: "Overwrite" }).catch((x: unknown) => x);
      expect(err).toBeInstanceOf(BootstrapRefusedError);
      expect((err as BootstrapRefusedError).code).toBe("email_in_use");

      expect(await db.user.findUniqueOrThrow({ where: { email: e } })).toEqual(before);
      expect(await db.user.count({ where: { role: UserRole.ADMIN } })).toBe(0); // and no ADMIN appeared
    }
  });

  it("refuses an invalid email and a weak / personal-info password, creating nothing", async () => {
    const users = await db.user.count();
    await expect(bootstrapFirstAdmin({ email: "not-an-email", password: PASSWORD })).rejects.toMatchObject({ code: "invalid_email" });
    await expect(bootstrapFirstAdmin({ email: email(), password: "short" })).rejects.toBeInstanceOf(WeakPasswordError);
    await expect(bootstrapFirstAdmin({ email: email("ada"), password: "ada-min-secret-123", firstName: "Ada", lastName: "Min" })).rejects.toBeInstanceOf(
      WeakPasswordError,
    );
    expect(await db.user.count()).toBe(users);
  });
});

describe("concurrency — only one first ADMIN can ever be created", () => {
  it("DETERMINISTIC: while one attempt is held open between its checks and its insert, a second (different email) cannot slip through", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let firstReachedInsert!: () => void;
    const reached = new Promise<void>((resolve) => (firstReachedInsert = resolve));

    const first = bootstrapFirstAdmin({ email: email("first"), password: PASSWORD }, db, {
      afterChecks: async () => {
        firstReachedInsert();
        await held; // checks passed, nothing inserted yet
      },
    });
    await reached;
    const second = bootstrapFirstAdmin({ email: email("second"), password: PASSWORD }, db);
    await new Promise((r) => setTimeout(r, 500)); // give the second ample time to (wrongly) pass its checks
    release();

    const [a, b] = await Promise.allSettled([first, second]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("rejected");
    expect(((b as PromiseRejectedResult).reason as BootstrapRefusedError).code).toBe("admin_exists");
    expect(await db.user.count({ where: { role: UserRole.ADMIN } })).toBe(1);
  });

  it("many simultaneous attempts with DIFFERENT emails: exactly one wins, the rest are refused", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => bootstrapFirstAdmin({ email: email(`race${i}`), password: PASSWORD })),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(7);
    for (const r of refused) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(BootstrapRefusedError);
      expect(((r as PromiseRejectedResult).reason as BootstrapRefusedError).code).toBe("admin_exists");
    }
    expect(await db.user.count({ where: { role: UserRole.ADMIN } })).toBe(1);
    expect(await db.user.count({ where: { email: { startsWith: PREFIX } } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: "auth.admin.bootstrapped", entityId: { not: null } } })).toBeGreaterThanOrEqual(1);
  });

  it("many simultaneous attempts with the SAME email: exactly one ADMIN row", async () => {
    const e = email("same");
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => bootstrapFirstAdmin({ email: e, password: PASSWORD })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected")) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(BootstrapRefusedError);
    }
    expect(await db.user.count({ where: { email: e } })).toBe(1);
    expect(await db.user.count({ where: { role: UserRole.ADMIN } })).toBe(1);
  });
});
