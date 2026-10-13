import { randomBytes } from "node:crypto";

import { UserRole } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addToCart } from "@/server/cart/cart-service";
import { placeOrder, quoteCheckout } from "@/server/orders/checkout-service";
import { ForbiddenError, UnauthenticatedError } from "@/server/auth/errors";
import { CatalogValidationError, ConflictError, NotFoundError } from "@/server/catalog/errors";
import {
  addShippingZoneRegion,
  createShippingMethod,
  createShippingZone,
  createTaxRate,
  createTaxRegion,
  fractionToPercent,
  getCheckoutCoverage,
  listShippingZones,
  listTaxRegions,
  percentToFraction,
  removeShippingZoneRegion,
  updateShippingMethod,
  updateShippingZone,
  updateTaxRate,
  updateTaxRegion,
} from "@/server/settings/tax-shipping-service";
import { cleanup, db, makeVariant } from "./helpers/db";
import {
  cleanupCheckout,
  ensureTaxAndShippingConfig,
  makeCart,
  placeOrderInput,
  validAddress,
  type TestShippingConfig,
} from "./helpers/checkout";

/**
 * Phase 11 admin tax / shipping configuration against a real, isolated
 * database. Uses its OWN jurisdictions so the shared fixture configuration
 * (Ontario / "Canada" zone) is never edited: tax region `YT` ("Test Yukon"),
 * and a zone named `zzz-cfg-<run>` covering `YT`. No rate or price in this file
 * is a real business value — they are arbitrary test numbers.
 */

const RUN = randomBytes(4).toString("hex");
const EMAIL = (role: string) => `cfg-${RUN}-${role}@taek.local`;
const ZONE_NAME = `zzz-cfg-${RUN}`;
const METHOD_NAME = `TestMethod-${RUN}`;

interface Actor {
  id: string;
  role: UserRole;
}
let admin: Actor;
let manager: Actor;
let staff: Actor;
let customer: Actor;
let cfg: TestShippingConfig;

async function mkActor(role: UserRole): Promise<Actor> {
  return db.user.create({
    data: { email: EMAIL(role.toLowerCase()), role, status: "ACTIVE", firstName: "Cfg", lastName: role },
    select: { id: true, role: true },
  });
}

beforeAll(async () => {
  cfg = await ensureTaxAndShippingConfig();
  [admin, manager, staff, customer] = await Promise.all([
    mkActor(UserRole.ADMIN),
    mkActor(UserRole.MANAGER),
    mkActor(UserRole.STAFF),
    mkActor(UserRole.CUSTOMER),
  ]);
});

afterAll(async () => {
  const actors = [admin, manager, staff, customer].filter(Boolean).map((a) => a.id);
  const regions = await db.taxRegion.findMany({ where: { name: { startsWith: "Test " + RUN } }, select: { id: true } });
  const zones = await db.shippingZone.findMany({ where: { name: { startsWith: "zzz-cfg-" + RUN } }, select: { id: true } });
  await cleanupCheckout();
  await db.auditLog.deleteMany({
    where: { OR: [{ actorUserId: { in: actors } }, { entityId: { in: [...regions, ...zones].map((r) => r.id) } }] },
  });
  await db.taxRegion.deleteMany({ where: { id: { in: regions.map((r) => r.id) } } });
  await db.shippingZone.deleteMany({ where: { id: { in: zones.map((z) => z.id) } } });
  await db.user.deleteMany({ where: { email: { startsWith: `cfg-${RUN}-` } } });
  await cleanup();
  await db.$disconnect();
});

describe("unit conversion", () => {
  it("percent ⇄ exact stored fraction, no floats", () => {
    expect(percentToFraction("13").toString()).toBe("0.13");
    expect(percentToFraction("9.975").toString()).toBe("0.09975");
    expect(percentToFraction("0").toString()).toBe("0");
    expect(fractionToPercent("0.130000")).toBe("13");
    expect(fractionToPercent(percentToFraction("9.975"))).toBe("9.975");
  });
});

describe("authorization — settings.write (ADMIN) for every read and write, enforced server-side", () => {
  const valid = {
    region: { name: `Test ${RUN} auth`, province: "NU", active: true },
  };

  it.each([
    ["no session", (): Actor | null => null, UnauthenticatedError],
    ["CUSTOMER", (): Actor | null => customer, ForbiddenError],
    ["STAFF", (): Actor | null => staff, ForbiddenError],
    ["MANAGER", (): Actor | null => manager, ForbiddenError],
  ] as const)("%s is refused on every function and nothing is written", async (_label, who, errorType) => {
    const actor = who();
    const before = {
      regions: await db.taxRegion.count(),
      rates: await db.taxRate.count(),
      zones: await db.shippingZone.count(),
      methods: await db.shippingMethod.count(),
      audits: await db.auditLog.count({ where: { action: { startsWith: "config." } } }),
    };
    const calls: Promise<unknown>[] = [
      listTaxRegions(actor),
      listShippingZones(actor),
      getCheckoutCoverage(actor),
      createTaxRegion(actor, valid.region),
      updateTaxRegion(actor, "x", { name: "n", active: true }),
      createTaxRate(actor, { regionId: "x", name: "T", ratePercent: "5", priority: "0", compound: false, active: true }),
      updateTaxRate(actor, "x", { ratePercent: "5", priority: "0", compound: false, active: true }),
      createShippingZone(actor, { name: ZONE_NAME + "-auth", active: true }),
      updateShippingZone(actor, "x", { name: "n", active: true }),
      addShippingZoneRegion(actor, { zoneId: "x", province: "YT" }),
      removeShippingZoneRegion(actor, "x"),
      createShippingMethod(actor, { zoneId: "x", name: "M", flatRateCents: "5.00", sortOrder: "0", active: true }),
      updateShippingMethod(actor, "x", { flatRateCents: "5.00", sortOrder: "0", active: true }),
    ];
    for (const call of calls) await expect(call).rejects.toBeInstanceOf(errorType);

    expect({
      regions: await db.taxRegion.count(),
      rates: await db.taxRate.count(),
      zones: await db.shippingZone.count(),
      methods: await db.shippingMethod.count(),
      audits: await db.auditLog.count({ where: { action: { startsWith: "config." } } }),
    }).toEqual(before);
  });

  it("ADMIN may read", async () => {
    await expect(listTaxRegions(admin)).resolves.toBeInstanceOf(Array);
    await expect(getCheckoutCoverage(admin)).resolves.toHaveLength(13);
  });
});

describe("validation — invalid values are rejected with a clear message and nothing is stored", () => {
  let regionId: string;
  let zoneId: string;
  beforeAll(async () => {
    regionId = (await createTaxRegion(admin, { name: `Test ${RUN} validation`, province: "NU", active: true })).id;
    zoneId = (await createShippingZone(admin, { name: `${ZONE_NAME}-validation`, active: true })).id;
  });

  const rate = (over: Record<string, unknown>) => ({
    regionId,
    name: "VT",
    ratePercent: "5",
    priority: "0",
    compound: false,
    active: true,
    ...over,
  });

  it.each([
    ["blank rate (there is no default)", { ratePercent: "" }, /percent/i],
    ["non-numeric rate", { ratePercent: "abc" }, /percent/i],
    ["negative rate", { ratePercent: "-1" }, /percent/i],
    ["over 100%", { ratePercent: "100.5" }, /exceed 100|percent/i],
    ["too many decimals", { ratePercent: "13.12345" }, /4 decimals/i],
    ["blank name", { name: "  " }, /required/i],
    ["non-integer priority", { priority: "1.5" }, /whole number|integer/i],
    ["malformed date", { effectiveFrom: "13/01/2026" }, /YYYY-MM-DD/],
    ["impossible date", { effectiveFrom: "2026-02-30" }, /valid calendar date|YYYY/i],
    ["effective to before from", { effectiveFrom: "2026-06-01", effectiveTo: "2026-05-01" }, /not be before/i],
  ])("tax rate: %s", async (_label, over, message) => {
    const err = await createTaxRate(admin, rate(over)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CatalogValidationError);
    expect((err as CatalogValidationError).publicMessage).toMatch(message);
    expect(await db.taxRate.count({ where: { regionId } })).toBe(0);
  });

  it("tax region: unknown province / blank name", async () => {
    await expect(createTaxRegion(admin, { name: "X", province: "ZZ", active: true })).rejects.toBeInstanceOf(CatalogValidationError);
    await expect(createTaxRegion(admin, { name: "X", province: "__choose", active: true })).rejects.toBeInstanceOf(CatalogValidationError);
    await expect(createTaxRegion(admin, { name: "", province: "NU", active: true })).rejects.toBeInstanceOf(CatalogValidationError);
  });

  const method = (over: Record<string, unknown>) => ({
    zoneId,
    name: METHOD_NAME + "-v",
    flatRateCents: "9.99",
    sortOrder: "0",
    active: true,
    ...over,
  });

  it.each([
    ["blank price (no free-shipping by omission)", { flatRateCents: "" }, /required/i],
    ["non-money price", { flatRateCents: "ten" }, /CAD dollars/i],
    ["negative price", { flatRateCents: "-1.00" }, /negative/i],
    ["absurd price", { flatRateCents: "999999.99" }, /unreasonably large/i],
    ["bad threshold", { freeShippingThresholdCents: "lots" }, /CAD dollars/i],
    ["min days above max", { minDeliveryDays: "9", maxDeliveryDays: "3" }, /cannot exceed/i],
    ["negative days", { minDeliveryDays: "-1" }, /./],
    ["blank name", { name: "" }, /required/i],
  ])("shipping method: %s", async (_label, over, message) => {
    const err = await createShippingMethod(admin, method(over)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CatalogValidationError);
    expect((err as CatalogValidationError).publicMessage).toMatch(message);
    expect(await db.shippingMethod.count({ where: { zoneId } })).toBe(0);
  });

  it("zone coverage: unknown province; unknown ids are NotFound", async () => {
    await expect(addShippingZoneRegion(admin, { zoneId, province: "ZZ" })).rejects.toBeInstanceOf(CatalogValidationError);
    await expect(addShippingZoneRegion(admin, { zoneId: "nope", province: "YT" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(createTaxRate(admin, rate({ regionId: "nope" }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateTaxRate(admin, "nope", { ratePercent: "5", priority: "0", compound: false, active: true })).rejects.toBeInstanceOf(NotFoundError);
    await expect(updateShippingMethod(admin, "nope", { flatRateCents: "5.00", sortOrder: "0", active: true })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("duplicates are conflicts, never overwrites", async () => {
    await createTaxRate(admin, rate({ name: "DUP" }));
    await expect(createTaxRate(admin, rate({ name: "DUP", ratePercent: "9" }))).rejects.toBeInstanceOf(ConflictError);
    expect(fractionToPercent((await db.taxRate.findFirstOrThrow({ where: { regionId, name: "DUP" } })).rate)).toBe("5");

    await expect(createTaxRegion(admin, { name: "again", province: "NU", active: true })).rejects.toBeInstanceOf(ConflictError);
    await expect(createShippingZone(admin, { name: `${ZONE_NAME}-validation`, active: true })).rejects.toBeInstanceOf(ConflictError);

    await createShippingMethod(admin, method({ name: "DUPM" }));
    await expect(createShippingMethod(admin, method({ name: "DUPM", flatRateCents: "1.00" }))).rejects.toBeInstanceOf(ConflictError);
    await addShippingZoneRegion(admin, { zoneId, province: "NU" });
    await expect(addShippingZoneRegion(admin, { zoneId, province: "NU" })).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("configuration changes drive NEW checkout quotes; historical orders never change", () => {
  const ADDRESS = { ...validAddress, province: "YT" as const, postalCode: "Y1A 1A1" };
  let regionId: string;
  let rateId: string;
  let zoneId: string;
  let methodId: string;

  async function newCart(qty = 1) {
    const v = await makeVariant({ onHand: 200 });
    const cart = await makeCart();
    await addToCart({ token: cart.token }, { variantId: v.variantId, quantity: qty });
    return { token: cart.token, v };
  }
  const quote = (token: string) => quoteCheckout({ token }, { province: "YT", shippingMethodId: methodId });
  const order = (token: string) =>
    placeOrder({ token }, placeOrderInput(cfg.shippingMethodId, { shippingAddress: ADDRESS, shippingMethodId: methodId }));

  beforeAll(async () => {
    regionId = (await createTaxRegion(admin, { name: `Test ${RUN} Yukon`, province: "YT", active: true })).id;
    rateId = (await createTaxRate(admin, { regionId, name: "TST", ratePercent: "5", priority: "0", compound: false, active: true })).id;
    zoneId = (await createShippingZone(admin, { name: ZONE_NAME, active: true })).id;
    await addShippingZoneRegion(admin, { zoneId, province: "YT" });
    methodId = (
      await createShippingMethod(admin, {
        zoneId,
        name: METHOD_NAME,
        flatRateCents: "9.99",
        freeShippingThresholdCents: "500",
        minDeliveryDays: "2",
        maxDeliveryDays: "5",
        sortOrder: "0",
        active: true,
      })
    ).id;
  });

  it("a configured rate and method appear in the quote with exact rounding; coverage reports them", async () => {
    const { token } = await newCart(1); // $10.00 item
    const q = (await quote(token))!;
    expect(q.taxRegionName).toBe(`Test ${RUN} Yukon`);
    expect(q.taxCents).toBe(50); // 5% of 1000
    expect(q.selectedShipping).toMatchObject({ methodId, priceCents: 999, free: false });
    expect(q.totalCents).toBe(1000 + 999 + 50);

    const yt = (await getCheckoutCoverage(admin)).find((c) => c.province === "YT")!;
    expect(yt.tax).toMatchObject({ configured: true, rates: [{ name: "TST", percent: "5" }] });
    expect(yt.shipping.methods.map((m) => m.name)).toContain(METHOD_NAME);
  });

  it("changing the rate and price affects only NEW orders; the earlier order's tax, shipping, total and line tax are unchanged", async () => {
    const first = await newCart(1);
    const placedA = await order(first.token);
    const a = await db.order.findUniqueOrThrow({ where: { id: placedA.id }, include: { items: true } });
    expect(a).toMatchObject({ taxCents: 50, shippingCents: 999, totalCents: 2049 });

    await updateTaxRate(admin, rateId, { ratePercent: "7.5", priority: "0", compound: false, active: true });
    await updateShippingMethod(admin, methodId, {
      flatRateCents: "14.00",
      freeShippingThresholdCents: "500",
      minDeliveryDays: "2",
      maxDeliveryDays: "5",
      sortOrder: "0",
      active: true,
    });

    const aAfter = await db.order.findUniqueOrThrow({ where: { id: placedA.id }, include: { items: true } });
    expect(aAfter.taxCents).toBe(a.taxCents);
    expect(aAfter.shippingCents).toBe(a.shippingCents);
    expect(aAfter.totalCents).toBe(a.totalCents);
    expect(aAfter.items.map((i) => i.lineTaxCents)).toEqual(a.items.map((i) => i.lineTaxCents));

    const second = await newCart(1);
    const q = (await quote(second.token))!;
    expect(q.taxCents).toBe(75); // 7.5% of 1000
    expect(q.shippingCents).toBe(1400);
    const placedB = await order(second.token);
    expect(await db.order.findUniqueOrThrow({ where: { id: placedB.id } })).toMatchObject({
      taxCents: 75,
      shippingCents: 1400,
      totalCents: 1000 + 1400 + 75,
    });
  });

  it("the free-shipping threshold is applied by the existing rule, only when configured and met", async () => {
    const big = await newCart(60); // $600.00 ≥ $500.00 threshold
    expect((await quote(big.token))!.selectedShipping).toMatchObject({ priceCents: 0, free: true });
    await updateShippingMethod(admin, methodId, {
      flatRateCents: "14.00",
      freeShippingThresholdCents: "", // cleared
      sortOrder: "0",
      active: true,
    });
    expect((await quote(big.token))!.selectedShipping).toMatchObject({ priceCents: 1400, free: false });
  });

  it("deactivating the method makes shipping UNAVAILABLE (nothing is substituted) and checkout refuses the order", async () => {
    await updateShippingMethod(admin, methodId, { flatRateCents: "14.00", sortOrder: "0", active: false });
    const { token } = await newCart(1);
    const q = (await quote(token))!;
    expect(q.shippingOptions.map((o) => o.methodId)).not.toContain(methodId);
    expect(q.selectedShipping).toBeNull();
    await expect(order(token)).rejects.toBeInstanceOf(CatalogValidationError);

    const yt = (await getCheckoutCoverage(admin)).find((c) => c.province === "YT")!;
    expect(yt.shipping.methods.map((m) => m.name)).not.toContain(METHOD_NAME);
    // The row still exists — deactivated, not deleted.
    expect(await db.shippingMethod.count({ where: { id: methodId } })).toBe(1);
  });

  it("deactivating the rate / region / an expired window ⇒ the EXISTING no-tax rule shows up explicitly (coverage 'not configured'), never silently", async () => {
    const yt = async () => (await getCheckoutCoverage(admin)).find((c) => c.province === "YT")!.tax;

    await updateTaxRate(admin, rateId, { ratePercent: "7.5", priority: "0", compound: false, active: false });
    expect(await yt()).toMatchObject({ configured: false, rates: [] });
    const { token } = await newCart(1);
    expect((await quote(token))!.taxCents).toBe(0); // existing rule: no tax rate ⇒ $0 — and the admin view says so

    await updateTaxRate(admin, rateId, { ratePercent: "7.5", priority: "0", compound: false, active: true, effectiveTo: "2000-01-01" });
    expect((await yt()).configured).toBe(false); // expired window

    await updateTaxRate(admin, rateId, { ratePercent: "7.5", priority: "0", compound: false, active: true });
    expect((await yt()).configured).toBe(true);
    await updateTaxRegion(admin, regionId, { name: `Test ${RUN} Yukon`, active: false });
    expect(await yt()).toMatchObject({ configured: false, regionName: null });
    expect((await quote(token))!.taxRegionName).toBeNull();
    await updateTaxRegion(admin, regionId, { name: `Test ${RUN} Yukon`, active: true });
    expect((await yt()).configured).toBe(true);
  });

  it("removing a zone's province coverage and deactivating the zone both end availability there", async () => {
    await updateShippingMethod(admin, methodId, { flatRateCents: "14.00", sortOrder: "0", active: true });
    const { token } = await newCart(1);
    expect((await quote(token))!.selectedShipping?.methodId).toBe(methodId);

    await updateShippingZone(admin, zoneId, { name: ZONE_NAME, active: false });
    expect((await quote(token))!.shippingOptions.map((o) => o.methodId)).not.toContain(methodId);
    await updateShippingZone(admin, zoneId, { name: ZONE_NAME, active: true });

    const link = await db.shippingZoneRegion.findFirstOrThrow({ where: { zoneId, province: "YT" } });
    await removeShippingZoneRegion(admin, link.id);
    expect((await quote(token))!.shippingOptions.map((o) => o.methodId)).not.toContain(methodId);
  });

  it("an unconfigured province is reported as such by the coverage view", async () => {
    // NU has a tax region from the validation suite with an active 5% rate; BC has nothing at all.
    const bc = (await getCheckoutCoverage(admin)).find((c) => c.province === "BC")!;
    expect(bc.tax).toMatchObject({ configured: false, regionName: null });
    expect(bc.shipping.methods.map((m) => m.name)).toContain("Standard"); // the shared "Canada" fixture is country-wide
  });

  it("every change left an audit record naming the admin, with before/after values", async () => {
    const rows = await db.auditLog.findMany({
      where: { entityId: rateId, action: "config.tax_rate.updated" },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((r) => r.actorUserId === admin.id)).toBe(true);
    expect(rows[0]!.metadata).toMatchObject({
      before: { ratePercent: "5" },
      after: { ratePercent: "7.5" },
    });
    expect(await db.auditLog.count({ where: { entityId: methodId, action: "config.shipping_method.updated" } })).toBeGreaterThanOrEqual(3);
    expect(await db.auditLog.count({ where: { entityId: regionId, action: "config.tax_region.created" } })).toBe(1);
    expect(await db.auditLog.count({ where: { entityId: zoneId, action: "config.shipping_zone_region.removed" } })).toBe(1);
    // The service offers no delete for regions, rates, zones or methods.
    expect(await db.taxRate.count({ where: { id: rateId } })).toBe(1);
  });
});
