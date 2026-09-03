// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";

import { FlatRateShippingProvider } from "@/server/shipping/shipping-provider";
import { createMockPrisma, type MockPrisma } from "./helpers/mock-prisma";

const FROM = { country: "CA", province: "" };
const TO = { country: "CA", province: "ON" };

const STANDARD = {
  id: "m1",
  name: "Standard",
  description: "Ground",
  flatRateCents: 1200,
  freeShippingThresholdCents: 15000,
  minDeliveryDays: 3,
  maxDeliveryDays: 7,
};

describe("FlatRateShippingProvider", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
  });

  it("maps active methods to options and charges the flat rate below the threshold", async () => {
    db.shippingMethod.findMany.mockResolvedValue([STANDARD] as never);
    const options = await new FlatRateShippingProvider(db).rates(
      { weightGrams: 800, subtotalCents: 5000 },
      FROM,
      TO,
    );
    expect(options).toEqual([
      {
        methodId: "m1",
        name: "Standard",
        description: "Ground",
        priceCents: 1200,
        free: false,
        minDeliveryDays: 3,
        maxDeliveryDays: 7,
      },
    ]);
  });

  it("zeroes the price when the subtotal meets the free-shipping threshold", async () => {
    db.shippingMethod.findMany.mockResolvedValue([STANDARD] as never);
    const [opt] = await new FlatRateShippingProvider(db).rates(
      { weightGrams: 800, subtotalCents: 15000 },
      FROM,
      TO,
    );
    expect(opt).toMatchObject({ priceCents: 0, free: true });
  });

  it("returns nothing when no method covers the destination", async () => {
    db.shippingMethod.findMany.mockResolvedValue([] as never);
    const options = await new FlatRateShippingProvider(db).rates(
      { weightGrams: 0, subtotalCents: 1000 },
      FROM,
      { country: "US", province: "NY" },
    );
    expect(options).toEqual([]);
  });
});
