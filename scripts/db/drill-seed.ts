/**
 * Restore-drill fixture: fills an ISOLATED, disposable source database with a small but
 * representative web of related records, using the application's own services and the
 * existing integration-test fixtures — checkout, payments (fake gateway), refunds,
 * cancellation, inventory — so the backup/restore drill proves something real.
 *
 * Synthetic data only; talks only to `DATABASE_URL`, which `scripts/db/restore-drill.sh`
 * points at a throwaway container. Refuses to run against anything but a loopback host
 * with a `drill_` database name. Never run this against dev or production.
 *
 * Run by the drill script:  tsx scripts/db/drill-seed.ts
 */
import { UserRole } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { hashPassword } from "@/server/auth/password";
import { addToCart } from "@/server/cart/cart-service";
import { placeOrder } from "@/server/orders/checkout-service";
import { finalizeFromPaymentIntent, startPayment } from "@/server/orders/payment-service";
import { changeOrderStatus } from "@/server/orders/order-management-service";
import { requestRefund } from "@/server/orders/refund-service";
import { __setPaymentGateway } from "@/server/domain/payments";
import { __setOrderMailer } from "@/server/notifications";
import { __setMailer } from "@/server/auth/mailer";
import { ensureTaxAndShippingConfig, makeCart, placeOrderInput } from "../../tests/integration/helpers/checkout";
import { makeVariant } from "../../tests/integration/helpers/db";
import { FakeStripeGateway } from "../../tests/integration/helpers/payments";
import { FakeOrderMailer } from "../../tests/integration/helpers/order-mailer";
import { FakeMailer } from "../../tests/integration/helpers/auth-mailer";

function assertDisposableTarget(): void {
  const url = new URL(process.env.DATABASE_URL ?? "");
  const db = url.pathname.replace(/^\//, "");
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || !db.startsWith("drill_")) {
    throw new Error("drill-seed refuses to run: DATABASE_URL must be a loopback host and a 'drill_*' database.");
  }
}

async function main(): Promise<void> {
  assertDisposableTarget();
  const gateway = new FakeStripeGateway();
  __setPaymentGateway(gateway);
  // In-memory mailers: no email is sent AND no preview file is written anywhere.
  __setOrderMailer(new FakeOrderMailer());
  __setMailer(new FakeMailer());
  const cfg = await ensureTaxAndShippingConfig(); // synthetic ON/13% + Canada/$12 test config

  const passwordHash = await hashPassword("Drill-Synthetic-Pass-2026!");
  const mkUser = (email: string, role: UserRole, first: string) =>
    prisma.user.create({
      data: { email, role, status: "ACTIVE", firstName: first, lastName: "Drill", passwordHash },
      select: { id: true, email: true, role: true },
    });
  const alice = await mkUser("alice@drill.example.test", UserRole.CUSTOMER, "Alice");
  const bob = await mkUser("bob@drill.example.test", UserRole.CUSTOMER, "Bob");
  const manager = await mkUser("manager@drill.example.test", UserRole.MANAGER, "Mina");

  const vA = await makeVariant({ onHand: 40 });
  const vB = await makeVariant({ onHand: 25 });
  const vC = await makeVariant({ onHand: 12 });

  async function order(userId: string | null, lines: { v: typeof vA; qty: number }[], email: string) {
    const cart = await makeCart();
    for (const l of lines) {
      await addToCart({ token: cart.token, userId }, { variantId: l.v.variantId, quantity: l.qty });
    }
    return placeOrder({ token: cart.token, userId }, placeOrderInput(cfg.shippingMethodId, { email }));
  }
  async function pay(orderNumber: string, userId: string | null) {
    await startPayment(orderNumber, { justPlaced: true, user: userId ? { id: userId, role: UserRole.CUSTOMER } : null }, {}, prisma, gateway);
    const payment = await prisma.payment.findFirstOrThrow({ where: { order: { orderNumber } } });
    const pi = gateway.patch(payment.providerPaymentId!, { status: "succeeded", amountReceived: payment.amountCents });
    await finalizeFromPaymentIntent(pi, "webhook", prisma, gateway);
  }

  // 1. Authenticated customer, two lines, paid -> CONFIRMED, stock committed.
  const o1 = await order(alice.id, [{ v: vA, qty: 3 }, { v: vB, qty: 2 }], "alice@drill.example.test");
  await pay(o1.orderNumber, alice.id);
  // 2. Another customer, paid, then a partial refund (money + refund records).
  const o2 = await order(bob.id, [{ v: vA, qty: 1 }, { v: vC, qty: 4 }], "bob@drill.example.test");
  await pay(o2.orderNumber, bob.id);
  await requestRefund(manager, o2.id, { amountCents: 1500, reason: "Drill partial refund", idempotencyKey: "drill-refund-key-0001" }, {}, prisma, gateway);
  // 3. Guest order left PENDING (open reservation, no payment row).
  await order(null, [{ v: vB, qty: 5 }], "guest@drill.example.test");
  // 4. Guest order cancelled by an admin action (reservation released).
  const o4 = await order(null, [{ v: vC, qty: 2 }], "guest2@drill.example.test");
  await changeOrderStatus(manager, o4.id, "CANCELLED", prisma, { gateway, claimsActiveSince: new Date("2000-01-01T00:00:00Z") });

  const counts = {
    users: await prisma.user.count(),
    products: await prisma.product.count(),
    orders: await prisma.order.count(),
    orderItems: await prisma.orderItem.count(),
    payments: await prisma.payment.count(),
    refunds: await prisma.refund.count(),
    stockMovements: await prisma.stockMovement.count(),
    auditLogs: await prisma.auditLog.count(),
  };
  console.info("[drill-seed] created:", JSON.stringify(counts));
}

main()
  .catch((error) => {
    console.error("[drill-seed] failed:", error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
