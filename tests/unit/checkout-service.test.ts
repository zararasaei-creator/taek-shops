// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NotFoundError } from "@/server/catalog/errors";
import { placeOrder, quoteCheckout } from "@/server/orders/checkout-service";
import { placeOrderSchema } from "@/lib/validation/checkout";
import { createMockPrisma, type MockPrisma } from "./helpers/mock-prisma";

const address = {
  firstName: "Dana",
  lastName: "Kim",
  line1: "10 Dojang Rd",
  city: "Toronto",
  province: "ON",
  postalCode: "M5V 2T6",
  country: "CA",
};
const input = { email: "b@example.com", shippingAddress: address, shippingMethodId: "m1" };

describe("placeOrder", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
  });

  it("throws when there is no cart token or no active cart", async () => {
    await expect(placeOrder({ token: null }, input, {}, db)).rejects.toBeInstanceOf(NotFoundError);

    db.order.findFirst.mockResolvedValue(null as never);
    db.cart.findFirst.mockResolvedValue(null as never);
    await expect(placeOrder({ token: "missing" }, input, {}, db)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("is idempotent — returns the existing order without opening a transaction", async () => {
    db.order.findFirst.mockResolvedValue({
      id: "o1",
      orderNumber: "TS-1",
      status: "PENDING",
      totalCents: 3460,
    } as never);
    const txSpy = vi.spyOn(db, "$transaction");

    const result = await placeOrder({ token: "t" }, input, {}, db);
    expect(result).toMatchObject({ id: "o1", orderNumber: "TS-1", alreadyExisted: true });
    expect(txSpy).not.toHaveBeenCalled();
  });

  it("quoteCheckout returns null when there is no active cart", async () => {
    db.cart.findFirst.mockResolvedValue(null as never);
    expect(await quoteCheckout({ token: "x" }, {}, db)).toBeNull();
  });
});

describe("placeOrderSchema", () => {
  it("accepts a valid order and strips any client-supplied money / item fields", () => {
    const parsed = placeOrderSchema.parse({
      ...input,
      subtotalCents: 1,
      totalCents: 1,
      items: [{ unitPriceCents: 1 }],
      customerNote: "leave at door",
    });
    expect(parsed).not.toHaveProperty("subtotalCents");
    expect(parsed).not.toHaveProperty("items");
    expect(parsed.customerNote).toBe("leave at door");
    expect(parsed.shippingAddress.postalCode).toBe("M5V 2T6");
  });

  it("rejects a bad province or postal code", () => {
    expect(
      placeOrderSchema.safeParse({ ...input, shippingAddress: { ...address, province: "XX" } })
        .success,
    ).toBe(false);
    expect(
      placeOrderSchema.safeParse({
        ...input,
        shippingAddress: { ...address, postalCode: "90210" },
      }).success,
    ).toBe(false);
  });
});
