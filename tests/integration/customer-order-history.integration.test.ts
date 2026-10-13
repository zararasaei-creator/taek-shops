import { UserRole } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { UnauthenticatedError } from "@/server/auth/errors";
import { NotFoundError } from "@/server/catalog/errors";
import { getMyOrderDetail, listMyOrders } from "@/server/orders/order-queries";
import { db } from "./helpers/db";

/**
 * Customer order-history ("My orders"), exercised against a real, isolated
 * database — the real `order-queries.ts` functions, real Prisma, real
 * ownership rules. Namespaced separately from every other integration
 * suite's fixtures:
 *   - customers : `phase8-history-{a,b}@taek.local`
 *   - orders    : orderNumber starts `PF8H-ORD-`
 */

const ORDER_PREFIX = "PF8H-ORD-";
const EMAIL_A = "phase8-history-a@taek.local";
const EMAIL_B = "phase8-history-b@taek.local";
const EMAIL_C = "phase8-history-c@taek.local";

let rand = 0;
function uid(): string {
  rand += 1;
  return `${Date.now().toString(36)}${rand}`;
}

async function ensureCustomer(email: string): Promise<{ id: string; role: UserRole }> {
  return db.user.upsert({
    where: { email },
    update: { role: UserRole.CUSTOMER, status: "ACTIVE" },
    create: { email, role: UserRole.CUSTOMER, status: "ACTIVE", firstName: "History", lastName: "Test" },
    select: { id: true, role: true },
  });
}

async function makeOrder(opts: {
  userId: string | null;
  email: string;
  totalCents: number;
  unitPriceCents: number;
}): Promise<string> {
  const orderNumber = `${ORDER_PREFIX}${uid()}`;
  await db.order.create({
    data: {
      orderNumber,
      userId: opts.userId,
      customerEmail: opts.email,
      status: "CONFIRMED",
      paymentStatus: "PAID",
      totalCents: opts.totalCents,
      subtotalCents: opts.totalCents,
      items: {
        create: {
          sku: `PF8H-SKU-${uid()}`,
          productName: "History Test Uniform",
          unitPriceCents: opts.unitPriceCents,
          quantity: 1,
          lineSubtotalCents: opts.unitPriceCents,
          lineTotalCents: opts.unitPriceCents,
        },
      },
      addresses: {
        create: {
          type: "SHIPPING",
          firstName: "History",
          lastName: "Buyer",
          line1: "1 Test Way",
          city: "Toronto",
          province: "ON",
          postalCode: "M5V 2T6",
          country: "CA",
        },
      },
    },
  });
  return orderNumber;
}

async function cleanup(): Promise<void> {
  await db.order.deleteMany({ where: { orderNumber: { startsWith: ORDER_PREFIX } } });
  await db.user.deleteMany({ where: { email: { in: [EMAIL_A, EMAIL_B, EMAIL_C] } } });
}

let customerA: { id: string; role: UserRole };
let customerB: { id: string; role: UserRole };
let customerC: { id: string; role: UserRole };

beforeAll(async () => {
  await cleanup();
  customerA = await ensureCustomer(EMAIL_A);
  customerB = await ensureCustomer(EMAIL_B);
  customerC = await ensureCustomer(EMAIL_C);
});

afterAll(async () => {
  await cleanup();
  await db.$disconnect();
});

describe("listMyOrders", () => {
  it("requires authentication", async () => {
    await expect(listMyOrders(null, {}, db)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("is empty for a customer with no orders", async () => {
    const result = await listMyOrders(customerB, {}, db);
    expect(result.orders).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("lists only this customer's own orders, newest first", async () => {
    const first = await makeOrder({ userId: customerA.id, email: EMAIL_A, totalCents: 1000, unitPriceCents: 1000 });
    await new Promise((r) => setTimeout(r, 5));
    const second = await makeOrder({ userId: customerA.id, email: EMAIL_A, totalCents: 2000, unitPriceCents: 2000 });
    // A guest order and a different customer's order must never appear for A.
    await makeOrder({ userId: null, email: EMAIL_A, totalCents: 9999, unitPriceCents: 9999 });
    await makeOrder({ userId: customerB.id, email: EMAIL_B, totalCents: 500, unitPriceCents: 500 });

    const result = await listMyOrders(customerA, {}, db);
    expect(result.total).toBe(2);
    expect(result.orders.map((o) => o.orderNumber)).toEqual([second, first]);
  });

  it("paginates with skip/take", async () => {
    await makeOrder({ userId: customerC.id, email: EMAIL_C, totalCents: 100, unitPriceCents: 100 });
    await makeOrder({ userId: customerC.id, email: EMAIL_C, totalCents: 200, unitPriceCents: 200 });

    const page1 = await listMyOrders(customerC, { take: 1, skip: 0 }, db);
    const page2 = await listMyOrders(customerC, { take: 1, skip: 1 }, db);
    expect(page1.orders).toHaveLength(1);
    expect(page2.orders).toHaveLength(1);
    expect(page1.orders[0]!.orderNumber).not.toBe(page2.orders[0]!.orderNumber);
    expect(page1.total).toBe(2);
  });
});

describe("getMyOrderDetail", () => {
  it("requires authentication", async () => {
    const orderNumber = await makeOrder({
      userId: customerA.id,
      email: EMAIL_A,
      totalCents: 1234,
      unitPriceCents: 1234,
    });
    await expect(getMyOrderDetail(null, orderNumber, db)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it("returns the order with its purchase-time snapshot, not any live price", async () => {
    const orderNumber = await makeOrder({
      userId: customerA.id,
      email: EMAIL_A,
      totalCents: 4321,
      unitPriceCents: 4321,
    });
    const order = await getMyOrderDetail(customerA, orderNumber, db);
    expect(order.orderNumber).toBe(orderNumber);
    expect(order.totalCents).toBe(4321);
    expect(order.items[0]!.unitPriceCents).toBe(4321);
    expect(order.items[0]!.productName).toBe("History Test Uniform");
    expect(order.addresses[0]!.line1).toBe("1 Test Way");
  });

  it("404s — never 403 — for another customer's order (no existence leak)", async () => {
    const orderNumber = await makeOrder({
      userId: customerB.id,
      email: EMAIL_B,
      totalCents: 777,
      unitPriceCents: 777,
    });
    await expect(getMyOrderDetail(customerA, orderNumber, db)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("404s for a guest order even when the customer's own email matches it exactly", async () => {
    // Never auto-attach a guest order to an account by matching email.
    const orderNumber = await makeOrder({
      userId: null,
      email: EMAIL_A,
      totalCents: 888,
      unitPriceCents: 888,
    });
    await expect(getMyOrderDetail(customerA, orderNumber, db)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("404s for a nonexistent order number", async () => {
    await expect(getMyOrderDetail(customerA, "PF8H-ORD-NOPE", db)).rejects.toBeInstanceOf(NotFoundError);
  });
});
