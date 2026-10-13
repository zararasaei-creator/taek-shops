import { FulfillmentStatus, OrderStatus, PaymentStatus, UserRole } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ForbiddenError, UnauthenticatedError } from "@/server/auth/errors";
import { InvalidStateTransitionError } from "@/server/catalog/errors";
import {
  changeOrderFulfillmentStatus,
  changeOrderStatus,
  getOrderDetail,
  listOrders,
} from "@/server/orders/order-management-service";
import { db } from "./helpers/db";
import { installNetworkGuard, type NetworkGuard } from "./helpers/network-guard";

/**
 * Phase 8 admin order-management, exercised against a real, isolated database
 * (never mocked) — the real `order-management-service.ts`, real Prisma, real
 * `AuditLog` rows. Namespaced separately from the Phase 5 fixtures so the two
 * suites never collide:
 *   - products : slug starts `zzz-phase8-`
 *   - variants : sku   starts `PF8-`
 *   - orders   : orderNumber starts `PF8-ORD-`
 *   - actors   : `phase8-{customer,staff,manager}@taek.local`
 */

const PRODUCT_SLUG_PREFIX = "zzz-phase8-";
const SKU_PREFIX = "PF8-";
const ORDER_PREFIX = "PF8-ORD-";

// These fixture orders have no payment record and the rollout boundary is not
// configured in the test environment (which fails closed — see
// admin-cancel.integration.test.ts); state explicitly that they are post-claim.
const POST_CLAIM = { claimsActiveSince: new Date("2000-01-01T00:00:00Z") };

let rand = 0;
function uid(): string {
  rand += 1;
  return `${Date.now().toString(36)}${rand}`;
}

interface Actor {
  id: string;
  role: UserRole;
}

async function ensureActor(role: UserRole): Promise<Actor> {
  const email = `phase8-${role.toLowerCase()}@taek.local`;
  return db.user.upsert({
    where: { email },
    update: { role, status: "ACTIVE" },
    create: { email, role, status: "ACTIVE", firstName: "Phase8", lastName: role },
    select: { id: true, role: true },
  });
}

/** A throwaway product + variant + inventory item, so a fulfilment/inventory
 * assertion has something real to check against. */
async function makeVariant(onHand = 5): Promise<{ variantId: string; inventoryItemId: string; sku: string }> {
  const suffix = uid();
  const sku = `${SKU_PREFIX}${suffix}`;
  const product = await db.product.create({
    data: {
      name: `Phase 8 Test ${suffix}`,
      slug: `${PRODUCT_SLUG_PREFIX}${suffix}`,
      status: "ACTIVE",
      active: true,
      variants: {
        create: {
          sku,
          priceCents: 1500,
          optionSignature: "",
          inventoryItem: { create: { quantityOnHand: onHand, quantityReserved: 0 } },
        },
      },
    },
    select: { variants: { select: { id: true, inventoryItem: { select: { id: true } } } } },
  });
  const variant = product.variants[0]!;
  return { variantId: variant.id, inventoryItemId: variant.inventoryItem!.id, sku };
}

async function makeOrder(opts: {
  status?: OrderStatus;
  paymentStatus?: PaymentStatus;
  fulfillmentStatus?: FulfillmentStatus;
  variant?: { variantId: string; sku: string };
}): Promise<string> {
  const order = await db.order.create({
    data: {
      orderNumber: `${ORDER_PREFIX}${uid()}`,
      customerEmail: "phase8-order@taek.local",
      status: opts.status ?? OrderStatus.PENDING,
      paymentStatus: opts.paymentStatus ?? PaymentStatus.UNPAID,
      fulfillmentStatus: opts.fulfillmentStatus ?? FulfillmentStatus.UNFULFILLED,
      totalCents: 1500,
      ...(opts.variant
        ? {
            items: {
              create: {
                variantId: opts.variant.variantId,
                sku: opts.variant.sku,
                productName: "Phase 8 Test",
                unitPriceCents: 1500,
                quantity: 1,
                lineSubtotalCents: 1500,
                lineTotalCents: 1500,
              },
            },
          }
        : {}),
    },
    select: { id: true },
  });
  return order.id;
}

async function cleanup(): Promise<void> {
  const actorEmails = [UserRole.CUSTOMER, UserRole.STAFF, UserRole.MANAGER].map(
    (r) => `phase8-${r.toLowerCase()}@taek.local`,
  );
  const actors = await db.user.findMany({ where: { email: { in: actorEmails } }, select: { id: true } });
  if (actors.length > 0) {
    await db.auditLog.deleteMany({ where: { actorUserId: { in: actors.map((a) => a.id) } } });
  }
  await db.order.deleteMany({ where: { orderNumber: { startsWith: ORDER_PREFIX } } });
  // Cascades variant -> inventory item -> stock movements.
  await db.product.deleteMany({ where: { slug: { startsWith: PRODUCT_SLUG_PREFIX } } });
  await db.user.deleteMany({ where: { email: { in: actorEmails } } });
}

let customer: Actor;
let staff: Actor;
let manager: Actor;

// Regression guard (see the isolation test at the end of this file): the cancel paths below
// resolve a payment gateway when an order has no payment record. They must use the fake
// default from the integration setup and NEVER the real Stripe transport — even when a
// Stripe key is present in the environment, which is deliberately simulated here.
let guard: NetworkGuard;
const originalStripeKey = process.env.STRIPE_SECRET_KEY;

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_present_but_must_never_be_used";
  guard = installNetworkGuard();
  await cleanup();
  [customer, staff, manager] = await Promise.all([
    ensureActor(UserRole.CUSTOMER),
    ensureActor(UserRole.STAFF),
    ensureActor(UserRole.MANAGER),
  ]);
});

afterAll(async () => {
  guard.restore();
  if (originalStripeKey === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = originalStripeKey;
  await cleanup();
  await db.$disconnect();
});

describe("authorization matches the documented policy", () => {
  it("listOrders / getOrderDetail: unauthenticated and CUSTOMER are denied, STAFF and MANAGER can read", async () => {
    const orderId = await makeOrder({});

    await expect(listOrders(null, {}, db)).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(listOrders(customer, {}, db)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listOrders(staff, {}, db)).resolves.toBeDefined();
    await expect(listOrders(manager, {}, db)).resolves.toBeDefined();

    await expect(getOrderDetail(null, orderId, db)).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(getOrderDetail(customer, orderId, db)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getOrderDetail(staff, orderId, db)).resolves.toBeDefined();
    await expect(getOrderDetail(manager, orderId, db)).resolves.toBeDefined();
  });

  it("changeOrderStatus / changeOrderFulfillmentStatus: STAFF (read-only) is denied write, only MANAGER can write", async () => {
    const orderId = await makeOrder({});

    await expect(changeOrderStatus(null, orderId, OrderStatus.CANCELLED, db)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    await expect(
      changeOrderStatus(customer, orderId, OrderStatus.CANCELLED, db),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(changeOrderStatus(staff, orderId, OrderStatus.CANCELLED, db)).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    await expect(
      changeOrderFulfillmentStatus(customer, orderId, FulfillmentStatus.FULFILLED, {}, db),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      changeOrderFulfillmentStatus(staff, orderId, FulfillmentStatus.FULFILLED, {}, db),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // MANAGER can write (order-status leg only here; fulfilment is exercised below).
    await expect(changeOrderStatus(manager, orderId, OrderStatus.CANCELLED, db, POST_CLAIM)).resolves.toBeDefined();
  });
});

describe("order-status transitions: valid, invalid, and the payment-safety block", () => {
  it("blocks PENDING -> CONFIRMED even for MANAGER, and leaves the order untouched", async () => {
    const orderId = await makeOrder({ status: OrderStatus.PENDING, paymentStatus: PaymentStatus.UNPAID });

    await expect(
      changeOrderStatus(manager, orderId, OrderStatus.CONFIRMED, db),
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);

    const persisted = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(persisted.status).toBe(OrderStatus.PENDING);
    expect(persisted.paymentStatus).toBe(PaymentStatus.UNPAID);
  });

  it("rejects an illegal transition (COMPLETED -> CANCELLED)", async () => {
    const orderId = await makeOrder({ status: OrderStatus.COMPLETED, paymentStatus: PaymentStatus.PAID });

    await expect(
      changeOrderStatus(manager, orderId, OrderStatus.CANCELLED, db),
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(
      OrderStatus.COMPLETED,
    );
  });

  it("a valid transition (CONFIRMED -> PROCESSING) persists and writes an audit record", async () => {
    const orderId = await makeOrder({ status: OrderStatus.CONFIRMED, paymentStatus: PaymentStatus.PAID });

    const result = await changeOrderStatus(manager, orderId, OrderStatus.PROCESSING, db);
    expect(result.from).toBe(OrderStatus.CONFIRMED);
    expect(result.to).toBe(OrderStatus.PROCESSING);

    const persisted = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(persisted.status).toBe(OrderStatus.PROCESSING);
    // PaymentStatus is untouched by an order-status change — the two axes stay independent.
    expect(persisted.paymentStatus).toBe(PaymentStatus.PAID);

    const audit = await db.auditLog.findFirst({
      where: { entityType: "Order", entityId: orderId, action: "order.status.changed" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit!.metadata).toMatchObject({ from: OrderStatus.CONFIRMED, to: OrderStatus.PROCESSING });
  });

  it("cancelling a PENDING order with real stock releases the reservation (delegates correctly)", async () => {
    const variant = await makeVariant(6);
    const orderId = await makeOrder({ status: OrderStatus.PENDING, variant });

    await changeOrderStatus(manager, orderId, OrderStatus.CANCELLED, db, POST_CLAIM);

    const item = await db.inventoryItem.findUniqueOrThrow({ where: { id: variant.inventoryItemId } });
    expect(item.quantityOnHand).toBe(6);
    expect(item.quantityReserved).toBe(0);
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).cancelledAt).not.toBeNull();
  });
});

describe("fulfilment status: requires PAID, never touches inventory, persists + audits", () => {
  it("refuses to fulfil an unpaid order", async () => {
    const orderId = await makeOrder({ status: OrderStatus.PENDING, paymentStatus: PaymentStatus.UNPAID });

    await expect(
      changeOrderFulfillmentStatus(manager, orderId, FulfillmentStatus.FULFILLED, {}, db),
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).fulfillmentStatus).toBe(
      FulfillmentStatus.UNFULFILLED,
    );
  });

  it("refuses to fulfil a cancelled order", async () => {
    const orderId = await makeOrder({
      status: OrderStatus.CANCELLED,
      paymentStatus: PaymentStatus.REFUNDED,
    });

    await expect(
      changeOrderFulfillmentStatus(manager, orderId, FulfillmentStatus.FULFILLED, {}, db),
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });

  it("a valid fulfilment change on a PAID order persists, audits, and never moves inventory", async () => {
    const variant = await makeVariant(4);
    const orderId = await makeOrder({
      status: OrderStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      variant,
    });

    const before = await db.inventoryItem.findUniqueOrThrow({ where: { id: variant.inventoryItemId } });
    const movementsBefore = await db.stockMovement.count({
      where: { inventoryItemId: variant.inventoryItemId },
    });

    const result = await changeOrderFulfillmentStatus(
      manager,
      orderId,
      FulfillmentStatus.FULFILLED,
      {},
      db,
    );
    expect(result.from).toBe(FulfillmentStatus.UNFULFILLED);
    expect(result.to).toBe(FulfillmentStatus.FULFILLED);

    const persisted = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(persisted.fulfillmentStatus).toBe(FulfillmentStatus.FULFILLED);
    expect(persisted.status).toBe(OrderStatus.CONFIRMED); // OrderStatus untouched
    expect(persisted.paymentStatus).toBe(PaymentStatus.PAID); // PaymentStatus untouched

    const after = await db.inventoryItem.findUniqueOrThrow({ where: { id: variant.inventoryItemId } });
    expect(after).toEqual(before);
    expect(
      await db.stockMovement.count({ where: { inventoryItemId: variant.inventoryItemId } }),
    ).toBe(movementsBefore);

    const audit = await db.auditLog.findFirst({
      where: { entityType: "Order", entityId: orderId, action: "order.fulfillment_status.changed" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit!.metadata).toMatchObject({
      from: FulfillmentStatus.UNFULFILLED,
      to: FulfillmentStatus.FULFILLED,
    });
  });
});

describe("test isolation: no real Stripe transport is ever used by this file", () => {
  it("made zero attempts through the Stripe adapter, http(s), fetch or a raw socket — including during the two payment-less cancel tests", () => {
    // The guard replaces every route a Stripe request could take with a recorder that
    // throws instead of connecting, so an empty list means nothing was even attempted
    // (and, by construction, nothing left the machine).
    expect(guard.attempts).toEqual([]);
  });
});
