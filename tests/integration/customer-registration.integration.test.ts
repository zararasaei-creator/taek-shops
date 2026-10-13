import { randomBytes } from "node:crypto";

import { UserRole, UserStatus, VerificationPurpose } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { registerSchema } from "@/lib/validation/auth";
import { addToCart } from "@/server/cart/cart-service";
import { placeOrder } from "@/server/orders/checkout-service";
import { getMyOrderDetail, listMyOrders } from "@/server/orders/order-queries";
import { authenticateWithCredentials } from "@/server/auth/authentication";
import { hashPassword } from "@/server/auth/password";
import { InMemoryRateLimiter } from "@/server/auth/rate-limit";
import { registerCustomer, resendVerificationForUser } from "@/server/auth/registration";
import { confirmEmailVerification, createVerificationToken } from "@/server/auth/verification";
import {
  EmailSendFailedError,
  InvalidCredentialsError,
  InvalidTokenError,
  RateLimitedError,
  UnauthenticatedError,
  WeakPasswordError,
} from "@/server/auth/errors";
import type { Mailer, VerificationEmail } from "@/server/auth/mailer";
import { NotFoundError } from "@/server/catalog/errors";
import { cleanup, db, makeVariant } from "./helpers/db";
import {
  cleanupCheckout,
  ensureTaxAndShippingConfig,
  makeCart,
  placeOrderInput,
  type TestShippingConfig,
} from "./helpers/checkout";
import { FakeMailer } from "./helpers/auth-mailer";

/**
 * Customer self-registration, verification and ownership — real services, real
 * isolated database, FAKE mailer only (no email of any kind leaves the
 * process) and a fresh in-memory rate limiter per test.
 */

const RUN = randomBytes(4).toString("hex");
const PREFIX = `reg-${RUN}-`;
const PASSWORD = "Correct-Horse-Battery-9!";
let seq = 0;
const email = (label = "user") => `${PREFIX}${label}${(seq += 1)}@taek.local`;
const person = (over: Partial<Parameters<typeof registerCustomer>[0]> = {}) => ({
  firstName: "Dana",
  lastName: "Kim",
  email: email(),
  password: PASSWORD,
  ipAddress: "203.0.113.7",
  userAgent: "vitest",
  ...over,
});

let cfg: TestShippingConfig;
let mailer: FakeMailer;
let limiter: InMemoryRateLimiter;
const deps = () => ({ mailer, limiter });

class FailingMailer implements Mailer {
  async sendPasswordReset(): Promise<void> {
    throw new Error("transport down");
  }
  async sendEmailVerification(_email: VerificationEmail): Promise<void> {
    throw new Error("transport down");
  }
}

beforeAll(async () => {
  cfg = await ensureTaxAndShippingConfig();
});
beforeEach(() => {
  mailer = new FakeMailer();
  limiter = new InMemoryRateLimiter();
});
afterAll(async () => {
  const users = await db.user.findMany({
    where: { email: { startsWith: PREFIX } },
    select: { id: true },
  });
  await cleanupCheckout();
  await db.verificationToken.deleteMany({ where: { identifier: { startsWith: PREFIX } } });
  await db.auditLog.deleteMany({
    where: {
      OR: [
        { actorUserId: { in: users.map((u) => u.id) } },
        { metadata: { path: ["email"], string_starts_with: PREFIX } },
      ],
    },
  });
  await db.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
  await cleanup();
  await db.$disconnect();
});
const userByEmail = (e: string) =>
  db.user.findUniqueOrThrow({
    where: { email: e },
    select: { id: true, email: true, role: true, status: true, emailVerifiedAt: true, firstName: true, lastName: true, passwordHash: true },
  });

describe("registration → verification → login/account access", () => {
  it("creates a server-controlled CUSTOMER (ACTIVE, unverified), requests one verification email, the unverified customer can sign in, and explicit verification then works exactly once", async () => {
    const input = person();
    const outcome = await registerCustomer(input, deps());

    expect(outcome).toEqual({ created: true, verificationEmail: "requested" });
    const user = await userByEmail(input.email);
    expect(user).toMatchObject({
      role: UserRole.CUSTOMER,
      status: UserStatus.ACTIVE,
      emailVerifiedAt: null,
      firstName: "Dana",
      lastName: "Kim",
    });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/); // hashed, never the plain password
    expect(user.passwordHash).not.toContain(PASSWORD);
    expect(mailer.emailVerificationCalls).toHaveLength(1);
    expect(mailer.emailVerificationCalls[0]!.to).toBe(input.email);
    expect(await db.auditLog.count({ where: { action: "user.registered", entityId: user.id } })).toBe(1);

    // Unverified, but may sign in (policy: ACTIVE + unverified).
    const signedIn = await authenticateWithCredentials(
      { email: input.email, password: PASSWORD },
      { limiter },
    );
    expect(signedIn).toMatchObject({ id: user.id, role: UserRole.CUSTOMER, emailVerifiedAt: null });

    // Explicit verification with the delivered token (fake delivery).
    const token = mailer.emailVerificationCalls[0]!.token;
    await confirmEmailVerification({ token });
    expect((await userByEmail(input.email)).emailVerifiedAt).not.toBeNull();
    // Single use.
    await expect(confirmEmailVerification({ token })).rejects.toBeInstanceOf(InvalidTokenError);
    // Still signs in afterwards.
    await expect(
      authenticateWithCredentials({ email: input.email, password: PASSWORD }, { limiter }),
    ).resolves.toMatchObject({ id: user.id });
  });

  it("invalid, expired, wrong-purpose and unknown tokens are all rejected the same way and verify nothing", async () => {
    const input = person();
    await registerCustomer(input, deps());
    const good = mailer.emailVerificationCalls[0]!.token;

    await expect(confirmEmailVerification({ token: "x".repeat(40) })).rejects.toBeInstanceOf(InvalidTokenError);

    // Expire the real token.
    await db.verificationToken.updateMany({
      where: { identifier: input.email, purpose: VerificationPurpose.EMAIL_VERIFICATION },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(confirmEmailVerification({ token: good })).rejects.toBeInstanceOf(InvalidTokenError);

    // A password-reset token cannot verify an email.
    const resetToken = await createVerificationToken(input.email, VerificationPurpose.PASSWORD_RESET);
    await expect(confirmEmailVerification({ token: resetToken })).rejects.toBeInstanceOf(InvalidTokenError);

    expect((await userByEmail(input.email)).emailVerifiedAt).toBeNull();
  });
});

describe("tampered inputs, weak passwords, duplicates, concurrency", () => {
  it("role / status / verification / permission fields are dropped by the schema and cannot reach the account even if forwarded", async () => {
    const tampered = {
      firstName: "Eve",
      lastName: "Mallory",
      email: email("tamper"),
      password: PASSWORD,
      role: "ADMIN",
      status: "DISABLED",
      emailVerifiedAt: new Date().toISOString(),
      permissions: ["user.role.write"],
    };
    const parsed = registerSchema.parse(tampered);
    expect(Object.keys(parsed).sort()).toEqual(["email", "firstName", "lastName", "password"]);

    // Belt and braces: even forwarding the raw tampered object to the service.
    await registerCustomer({ ...tampered } as never, deps());
    expect(await userByEmail(tampered.email)).toMatchObject({
      role: UserRole.CUSTOMER,
      status: UserStatus.ACTIVE,
      emailVerifiedAt: null,
    });
  });

  it("a weak or personal-info password is refused: no account, no email", async () => {
    const input = person({ password: "short" });
    await expect(registerCustomer(input, deps())).rejects.toBeInstanceOf(WeakPasswordError);
    await expect(registerCustomer(person({ email: email("p"), password: "dana-kim-secret" }), deps())).rejects.toBeInstanceOf(
      WeakPasswordError,
    );
    expect(await db.user.count({ where: { email: input.email } })).toBe(0);
    expect(mailer.emailVerificationCalls).toHaveLength(0);
  });

  it("registering an existing email never overwrites the account (password, role, name, status) and sends nothing — even for a privileged account", async () => {
    const adminEmail = email("admin");
    const adminHash = await hashPassword("Admin-Original-Pass-77!");
    await db.user.create({
      data: {
        email: adminEmail,
        role: UserRole.ADMIN,
        status: UserStatus.ACTIVE,
        firstName: "Real",
        lastName: "Admin",
        passwordHash: adminHash,
        emailVerifiedAt: new Date(),
      },
    });

    const outcome = await registerCustomer(
      person({ email: adminEmail, firstName: "Attacker", lastName: "Person", password: "Zebra-Quartz-Vector-55!" }),
      deps(),
    );

    expect(outcome).toEqual({ created: false });
    const after = await userByEmail(adminEmail);
    expect(after).toMatchObject({ role: UserRole.ADMIN, firstName: "Real", lastName: "Admin", status: UserStatus.ACTIVE });
    expect(after.passwordHash).toBe(adminHash);
    expect(after.emailVerifiedAt).not.toBeNull();
    expect(mailer.emailVerificationCalls).toHaveLength(0);
    await expect(
      authenticateWithCredentials({ email: adminEmail, password: "Zebra-Quartz-Vector-55!" }, { limiter }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    await expect(
      authenticateWithCredentials({ email: adminEmail, password: "Admin-Original-Pass-77!" }, { limiter }),
    ).resolves.toMatchObject({ role: UserRole.ADMIN });
  });

  it("duplicate email differing only in case/whitespace is the same account", async () => {
    const e = email("case");
    await registerCustomer(person({ email: e }), deps());
    const again = await registerCustomer(person({ email: `  ${e.toUpperCase()} ` }), deps());
    expect(again).toEqual({ created: false });
    expect(await db.user.count({ where: { email: e } })).toBe(1);
  });

  it("concurrent registrations of the same email: the unique constraint yields exactly one account and one email, and nobody errors", async () => {
    const e = email("race");
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        registerCustomer(person({ email: e, firstName: `Racer${i}`, ipAddress: `198.51.100.${i}` }), deps()),
      ),
    );

    expect(outcomes.filter((o) => o.created)).toHaveLength(1);
    expect(outcomes.filter((o) => !o.created)).toHaveLength(5);
    expect(await db.user.count({ where: { email: e } })).toBe(1);
    expect(mailer.emailVerificationCalls).toHaveLength(1);
    const winner = await userByEmail(e);
    expect(winner.firstName).toMatch(/^Racer\d$/);
    expect(winner.role).toBe(UserRole.CUSTOMER);
  });
});

describe("mail transport failure and resend", () => {
  it("a failing transport leaves a usable account; resend recovers it, and tells the truth about failure", async () => {
    const input = person();
    const outcome = await registerCustomer(input, { mailer: new FailingMailer(), limiter });
    expect(outcome).toEqual({ created: true, verificationEmail: "failed" });
    const user = await userByEmail(input.email);
    expect(user.status).toBe(UserStatus.ACTIVE);
    await expect(
      authenticateWithCredentials({ email: input.email, password: PASSWORD }, { limiter }),
    ).resolves.toMatchObject({ id: user.id });
    expect(
      await db.auditLog.count({ where: { action: "user.registered", entityId: user.id } }),
    ).toBe(1);

    // Resend while the transport is still down: honest failure, audited.
    await expect(
      resendVerificationForUser(user as never, {}, { mailer: new FailingMailer(), limiter }),
    ).rejects.toBeInstanceOf(EmailSendFailedError);
    expect(
      await db.auditLog.count({ where: { action: "auth.email.verification_send_failed", entityId: user.id } }),
    ).toBe(1);

    // Resend once it is back: a fresh token, and it verifies.
    await expect(resendVerificationForUser(user as never, {}, deps())).resolves.toBe("requested");
    expect(mailer.emailVerificationCalls).toHaveLength(1);
    await confirmEmailVerification({ token: mailer.emailVerificationCalls[0]!.token });
    expect((await userByEmail(input.email)).emailVerifiedAt).not.toBeNull();
  });

  it("resend requires a signed-in user, is a no-op once verified, and a newer link invalidates the older one", async () => {
    await expect(resendVerificationForUser(null, {}, deps())).rejects.toBeInstanceOf(UnauthenticatedError);

    const input = person();
    await registerCustomer(input, deps());
    const user = await userByEmail(input.email);
    const first = mailer.emailVerificationCalls[0]!.token;

    await resendVerificationForUser(user as never, {}, deps());
    const second = mailer.emailVerificationCalls[1]!.token;
    expect(second).not.toBe(first);
    await expect(confirmEmailVerification({ token: first })).rejects.toBeInstanceOf(InvalidTokenError);
    await confirmEmailVerification({ token: second });

    const verified = await userByEmail(input.email);
    const before = mailer.emailVerificationCalls.length;
    await expect(resendVerificationForUser(verified as never, {}, deps())).resolves.toBe("already_verified");
    expect(mailer.emailVerificationCalls).toHaveLength(before);
  });

  it("resend is rate limited (5/hour per email) and registration is rate limited per email and per IP", async () => {
    const input = person();
    await registerCustomer(input, deps()); // consumes 1 of 5 verification requests
    const user = await userByEmail(input.email);

    for (let i = 0; i < 4; i++) {
      await expect(resendVerificationForUser(user as never, {}, deps())).resolves.toBe("requested");
    }
    await expect(resendVerificationForUser(user as never, {}, deps())).rejects.toBeInstanceOf(RateLimitedError);
    expect(mailer.emailVerificationCalls).toHaveLength(5); // the 6th never reached the transport

    // Registration: per IP …
    const ipLimiter = new InMemoryRateLimiter();
    for (let i = 0; i < 10; i++) {
      await registerCustomer(person({ email: email("ip"), ipAddress: "192.0.2.50" }), { mailer, limiter: ipLimiter });
    }
    await expect(
      registerCustomer(person({ email: email("ip"), ipAddress: "192.0.2.50" }), { mailer, limiter: ipLimiter }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    // … and per email (different IPs, same address).
    const emailLimiter = new InMemoryRateLimiter();
    const same = email("same");
    for (let i = 0; i < 10; i++) {
      await registerCustomer(person({ email: same, ipAddress: `192.0.2.${100 + i}` }), { mailer, limiter: emailLimiter });
    }
    await expect(
      registerCustomer(person({ email: same, ipAddress: "192.0.2.200" }), { mailer, limiter: emailLimiter }),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe("customer order ownership; guest checkout and historical guest orders are untouched", () => {
  async function buy(identity: { userId?: string | null }, qty = 1) {
    const v = await makeVariant({ onHand: 20 });
    const cart = await makeCart();
    await addToCart({ token: cart.token, userId: identity.userId ?? null }, { variantId: v.variantId, quantity: qty });
    return { cart, v };
  }

  it("an order placed while authenticated belongs to that customer and appears only in their history; a guest order of the same email belongs to nobody and is never auto-claimed", async () => {
    const a = person();
    const b = person();
    await registerCustomer(a, deps());
    await registerCustomer(b, deps());
    const userA = await userByEmail(a.email);
    const userB = await userByEmail(b.email);

    // A historical guest order placed with A's own email BEFORE they had an account.
    const guestCart = await buy({});
    const guest = await placeOrder({ token: guestCart.cart.token }, placeOrderInput(cfg.shippingMethodId, { email: a.email }));

    // Verify A's email, then place an authenticated order.
    await confirmEmailVerification({ token: mailer.emailVerificationCalls[0]!.token });
    const authed = await buy({ userId: userA.id });
    const mine = await placeOrder(
      { token: authed.cart.token, userId: userA.id },
      placeOrderInput(cfg.shippingMethodId),
    );

    expect((await db.order.findUniqueOrThrow({ where: { id: mine.id } })).userId).toBe(userA.id);
    expect((await db.order.findUniqueOrThrow({ where: { id: guest.id } })).userId).toBeNull();

    const aOrders = await listMyOrders(userA as never);
    expect(aOrders.orders.map((o) => o.orderNumber)).toEqual([mine.orderNumber]); // not the guest order
    expect((await listMyOrders(userB as never)).total).toBe(0);
    await expect(getMyOrderDetail(userB as never, mine.orderNumber)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getMyOrderDetail(userA as never, guest.orderNumber)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a cart first used while signed in, then continued as a guest, yields a GUEST order (not attributed to the earlier customer)", async () => {
    const a = person();
    await registerCustomer(a, deps());
    const userA = await userByEmail(a.email);

    const { cart } = await buy({ userId: userA.id }); // cart.userId becomes A
    expect((await db.cart.findUniqueOrThrow({ where: { id: cart.id } })).userId).toBe(userA.id);

    const order = await placeOrder({ token: cart.token }, placeOrderInput(cfg.shippingMethodId)); // signed out
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).userId).toBeNull();
    expect((await listMyOrders(userA as never)).total).toBe(0);
  });

  it("guest checkout still works with no account at all", async () => {
    const { cart } = await buy({});
    const order = await placeOrder({ token: cart.token }, placeOrderInput(cfg.shippingMethodId));
    expect(order.orderNumber).toMatch(/^TS-/);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).userId).toBeNull();
  });
});
