import { Prisma, type PrismaClient } from "@prisma/client";
import type { z } from "zod";

import { prisma } from "@/server/db/client";
import { requirePermission, type AuthUser } from "@/server/auth/authorization";
import { recordAudit } from "@/server/audit/audit-service";
import { AUDIT_ACTIONS } from "@/server/audit/actions";
import { CatalogValidationError, ConflictError, NotFoundError } from "@/server/catalog/errors";
import { CA_PROVINCES } from "@/lib/validation/checkout";
import {
  shippingMethodCreateSchema,
  shippingMethodUpdateSchema,
  shippingZoneCreateSchema,
  shippingZoneRegionSchema,
  shippingZoneUpdateSchema,
  taxRateCreateSchema,
  taxRateUpdateSchema,
  taxRegionCreateSchema,
  taxRegionUpdateSchema,
} from "@/lib/validation/tax-shipping";
import { ConfiguredRateTaxCalculator } from "@/server/tax/tax-calculator";
import { FlatRateShippingProvider } from "@/server/shipping/shipping-provider";

/**
 * Admin maintenance of the tax and shipping configuration the checkout already
 * reads (Phase 11). It REUSES the existing models (`TaxRegion`, `TaxRate`,
 * `ShippingZone`, `ShippingZoneRegion`, `ShippingMethod`) and the existing
 * calculators (`ConfiguredRateTaxCalculator`, `FlatRateShippingProvider`) —
 * no new tables, no new calculation rules.
 *
 * **Authorization.** Every function requires `settings.write` (ADMIN) — reads
 * included, as there is no narrower existing permission and this is
 * business-sensitive configuration. Checked server-side here; the pages and
 * actions are never the security boundary.
 *
 * **No hard deletes.** Nothing here deletes a region, rate, zone or method:
 * configuration is switched off (`active = false`) instead, so what applied
 * historically stays inspectable. (The one exception is removing a zone↔province
 * link, which is a join row with no history of its own and is audited.)
 *
 * **Historical orders are untouched by construction.** An order stores its own
 * snapshot — `Order.shippingCents`/`taxCents`/`totalCents` and
 * `OrderItem.lineTaxCents` — and has no foreign key to any row edited here, so
 * changing a rate or price affects only FUTURE quotes.
 *
 * **Nothing is invented.** The code ships no rate and no price; every value is
 * typed by the operator, with no defaults for a rate or a price (blank is a
 * validation error). Immutable identity fields (a region's province, a rate's
 * name/category, a method's zone/name) are not editable: change them by adding a
 * new row and deactivating the old one.
 */

type Db = PrismaClient;
type Actor = AuthUser | null | undefined;

export interface Meta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

const PERMISSION = "settings.write" as const;

/** Parse form-shaped input or throw a user-safe validation error (never a raw ZodError). */
function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => {
    const field = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return `${field}${issue.message}`;
  });
  throw new CatalogValidationError(issues.join(" "), result.error.flatten());
}

// ---- Rate unit conversion (percent ⇄ exact stored fraction) ------------------

/** "13" → Decimal(0.13); "9.975" → Decimal(0.09975). Exact — never a float. */
export function percentToFraction(percent: string): Prisma.Decimal {
  return new Prisma.Decimal(percent).div(100);
}

/** Decimal(0.130000) → "13"; Decimal(0.099750) → "9.975". For display. */
export function fractionToPercent(fraction: Prisma.Decimal | string | number): string {
  return new Prisma.Decimal(fraction).mul(100).toString();
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

async function audit(
  action: (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS],
  actor: AuthUser,
  entityType: string,
  entityId: string,
  metadata: Record<string, unknown>,
  meta: Meta,
  db: Db,
): Promise<void> {
  await recordAudit(
    {
      action,
      actorUserId: actor.id,
      entityType,
      entityId,
      metadata,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
    db,
  );
}

// =============================================================================
// Reads
// =============================================================================

const taxRegionInclude = {
  rates: { orderBy: [{ priority: "asc" }, { name: "asc" }] },
} satisfies Prisma.TaxRegionInclude;

export type TaxRegionWithRates = Prisma.TaxRegionGetPayload<{ include: typeof taxRegionInclude }>;

export async function listTaxRegions(actor: Actor, db: Db = prisma): Promise<TaxRegionWithRates[]> {
  requirePermission(actor, PERMISSION);
  return db.taxRegion.findMany({
    include: taxRegionInclude,
    orderBy: [{ country: "asc" }, { province: "asc" }],
  });
}

const shippingZoneInclude = {
  regions: { orderBy: [{ country: "asc" }, { province: "asc" }] },
  methods: { orderBy: [{ sortOrder: "asc" }, { name: "asc" }] },
} satisfies Prisma.ShippingZoneInclude;

export type ShippingZoneWithDetails = Prisma.ShippingZoneGetPayload<{
  include: typeof shippingZoneInclude;
}>;

export async function listShippingZones(
  actor: Actor,
  db: Db = prisma,
): Promise<ShippingZoneWithDetails[]> {
  requirePermission(actor, PERMISSION);
  return db.shippingZone.findMany({ include: shippingZoneInclude, orderBy: { name: "asc" } });
}

export interface ProvinceCoverage {
  province: string;
  tax: {
    /** True only when an active region AND at least one currently-effective rate apply. */
    configured: boolean;
    regionName: string | null;
    rates: { name: string; percent: string }[];
  };
  shipping: { methods: { name: string; priceCents: number }[] };
}

/**
 * What a checkout to each province/territory would do RIGHT NOW, computed by the
 * very calculators the checkout uses (so it can never disagree with them):
 *  - tax: for a standard-category product — the active region and rates that
 *    would apply, or none;
 *  - shipping: the options offered for an order of $0 (no free-shipping
 *    threshold applied), or none.
 * It exists so missing configuration is VISIBLE to the operator. Under the
 * existing checkout rules a province with no tax configuration charges NO tax,
 * and one with no shipping method cannot check out at all.
 */
export async function getCheckoutCoverage(
  actor: Actor,
  db: Db = prisma,
  at: Date = new Date(),
): Promise<ProvinceCoverage[]> {
  requirePermission(actor, PERMISSION);
  const tax = new ConfiguredRateTaxCalculator(db);
  const shipping = new FlatRateShippingProvider(db);

  const result: ProvinceCoverage[] = [];
  for (const province of CA_PROVINCES) {
    const dest = { country: "CA", province };
    const quote = await tax.quote([{ ref: "sample", taxableCents: 10_000, taxCategory: null }], dest, at);
    const applied = quote.lines[0]?.rates ?? [];
    const options = await shipping.rates(
      { weightGrams: 0, subtotalCents: 0 },
      { country: "CA", province: "" },
      dest,
    );
    result.push({
      province,
      tax: {
        configured: quote.regionName !== null && applied.length > 0,
        regionName: quote.regionName,
        rates: applied.map((r) => ({ name: r.name, percent: fractionToPercent(r.rate) })),
      },
      shipping: { methods: options.map((o) => ({ name: o.name, priceCents: o.priceCents })) },
    });
  }
  return result;
}

// =============================================================================
// Tax writes
// =============================================================================

export async function createTaxRegion(actor: Actor, input: unknown, meta: Meta = {}, db: Db = prisma) {
  const authed = requirePermission(actor, PERMISSION);
  const data = parseInput(taxRegionCreateSchema, input);
  try {
    const region = await db.taxRegion.create({
      data: { name: data.name, country: "CA", province: data.province, active: data.active },
    });
    await audit(AUDIT_ACTIONS.TAX_REGION_CREATED, authed, "TaxRegion", region.id, {
      name: region.name,
      country: region.country,
      province: region.province,
      active: region.active,
    }, meta, db);
    return region;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        data.province === ""
          ? "A country-wide tax region already exists. Edit it instead."
          : `A tax region for ${data.province} already exists. Edit it instead.`,
      );
    }
    throw error;
  }
}

export async function updateTaxRegion(
  actor: Actor,
  id: string,
  input: unknown,
  meta: Meta = {},
  db: Db = prisma,
) {
  const authed = requirePermission(actor, PERMISSION);
  const data = parseInput(taxRegionUpdateSchema, input);
  const current = await db.taxRegion.findUnique({ where: { id } });
  if (!current) throw new NotFoundError("Tax region", id);

  const region = await db.taxRegion.update({ where: { id }, data: { name: data.name, active: data.active } });
  await audit(AUDIT_ACTIONS.TAX_REGION_UPDATED, authed, "TaxRegion", id, {
    province: region.province,
    before: { name: current.name, active: current.active },
    after: { name: region.name, active: region.active },
  }, meta, db);
  return region;
}

export async function createTaxRate(actor: Actor, input: unknown, meta: Meta = {}, db: Db = prisma) {
  const authed = requirePermission(actor, PERMISSION);
  const data = parseInput(taxRateCreateSchema, input);
  const region = await db.taxRegion.findUnique({ where: { id: data.regionId } });
  if (!region) throw new NotFoundError("Tax region", data.regionId);

  try {
    const rate = await db.taxRate.create({
      data: {
        regionId: data.regionId,
        name: data.name,
        taxCategory: data.taxCategory,
        rate: percentToFraction(data.ratePercent),
        priority: data.priority,
        compound: data.compound,
        active: data.active,
        effectiveFrom: data.effectiveFrom,
        effectiveTo: data.effectiveTo,
      },
    });
    await audit(AUDIT_ACTIONS.TAX_RATE_CREATED, authed, "TaxRate", rate.id, {
      region: region.name,
      province: region.province,
      name: rate.name,
      taxCategory: rate.taxCategory,
      ratePercent: fractionToPercent(rate.rate),
      priority: rate.priority,
      compound: rate.compound,
      active: rate.active,
      effectiveFrom: rate.effectiveFrom?.toISOString() ?? null,
      effectiveTo: rate.effectiveTo?.toISOString() ?? null,
    }, meta, db);
    return rate;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        `${region.name} already has a "${data.name}" rate${data.taxCategory ? ` for category "${data.taxCategory}"` : ""}. Edit it instead.`,
      );
    }
    throw error;
  }
}

export async function updateTaxRate(
  actor: Actor,
  id: string,
  input: unknown,
  meta: Meta = {},
  db: Db = prisma,
) {
  const authed = requirePermission(actor, PERMISSION);
  const data = parseInput(taxRateUpdateSchema, input);
  const current = await db.taxRate.findUnique({ where: { id } });
  if (!current) throw new NotFoundError("Tax rate", id);

  const rate = await db.taxRate.update({
    where: { id },
    data: {
      rate: percentToFraction(data.ratePercent),
      priority: data.priority,
      compound: data.compound,
      active: data.active,
      effectiveFrom: data.effectiveFrom,
      effectiveTo: data.effectiveTo,
    },
  });
  await audit(AUDIT_ACTIONS.TAX_RATE_UPDATED, authed, "TaxRate", id, {
    name: rate.name,
    before: {
      ratePercent: fractionToPercent(current.rate),
      priority: current.priority,
      compound: current.compound,
      active: current.active,
      effectiveFrom: current.effectiveFrom?.toISOString() ?? null,
      effectiveTo: current.effectiveTo?.toISOString() ?? null,
    },
    after: {
      ratePercent: fractionToPercent(rate.rate),
      priority: rate.priority,
      compound: rate.compound,
      active: rate.active,
      effectiveFrom: rate.effectiveFrom?.toISOString() ?? null,
      effectiveTo: rate.effectiveTo?.toISOString() ?? null,
    },
  }, meta, db);
  return rate;
}

// =============================================================================
// Shipping writes
// =============================================================================

export async function createShippingZone(actor: Actor, input: unknown, meta: Meta = {}, db: Db = prisma) {
  const authed = requirePermission(actor, PERMISSION);
  const data = parseInput(shippingZoneCreateSchema, input);
  try {
    const zone = await db.shippingZone.create({ data: { name: data.name, active: data.active } });
    await audit(AUDIT_ACTIONS.SHIPPING_ZONE_CREATED, authed, "ShippingZone", zone.id, {
      name: zone.name,
      active: zone.active,
    }, meta, db);
    return zone;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`A shipping zone named "${data.name}" already exists.`);
    throw error;
  }
}

export async function updateShippingZone(
  actor: Actor,
  id: string,
  input: unknown,
  meta: Meta = {},
  db: Db = prisma,
) {
  const authed = requirePermission(actor, PERMISSION);
  const data = parseInput(shippingZoneUpdateSchema, input);
  const current = await db.shippingZone.findUnique({ where: { id } });
  if (!current) throw new NotFoundError("Shipping zone", id);
  try {
    const zone = await db.shippingZone.update({ where: { id }, data: { name: data.name, active: data.active } });
    await audit(AUDIT_ACTIONS.SHIPPING_ZONE_UPDATED, authed, "ShippingZone", id, {
      before: { name: current.name, active: current.active },
      after: { name: zone.name, active: zone.active },
    }, meta, db);
    return zone;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`A shipping zone named "${data.name}" already exists.`);
    throw error;
  }
}

export async function addShippingZoneRegion(actor: Actor, input: unknown, meta: Meta = {}, db: Db = prisma) {
  const authed = requirePermission(actor, PERMISSION);
  const data = parseInput(shippingZoneRegionSchema, input);
  const zone = await db.shippingZone.findUnique({ where: { id: data.zoneId } });
  if (!zone) throw new NotFoundError("Shipping zone", data.zoneId);
  try {
    const region = await db.shippingZoneRegion.create({
      data: { zoneId: data.zoneId, country: "CA", province: data.province },
    });
    await audit(AUDIT_ACTIONS.SHIPPING_ZONE_REGION_ADDED, authed, "ShippingZone", zone.id, {
      zone: zone.name,
      country: "CA",
      province: data.province,
    }, meta, db);
    return region;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        `${zone.name} already covers ${data.province === "" ? "all of Canada" : data.province}.`,
      );
    }
    throw error;
  }
}

/** Removes a zone↔province link. A join row with no history of its own; audited. */
export async function removeShippingZoneRegion(
  actor: Actor,
  regionId: string,
  meta: Meta = {},
  db: Db = prisma,
) {
  const authed = requirePermission(actor, PERMISSION);
  const region = await db.shippingZoneRegion.findUnique({
    where: { id: regionId },
    include: { zone: { select: { id: true, name: true } } },
  });
  if (!region) throw new NotFoundError("Zone region", regionId);
  await db.shippingZoneRegion.delete({ where: { id: regionId } });
  await audit(AUDIT_ACTIONS.SHIPPING_ZONE_REGION_REMOVED, authed, "ShippingZone", region.zone.id, {
    zone: region.zone.name,
    country: region.country,
    province: region.province,
  }, meta, db);
}

export async function createShippingMethod(actor: Actor, input: unknown, meta: Meta = {}, db: Db = prisma) {
  const authed = requirePermission(actor, PERMISSION);
  const data = parseInput(shippingMethodCreateSchema, input);
  const zone = await db.shippingZone.findUnique({ where: { id: data.zoneId } });
  if (!zone) throw new NotFoundError("Shipping zone", data.zoneId);
  try {
    const method = await db.shippingMethod.create({
      data: {
        zoneId: data.zoneId,
        name: data.name,
        description: data.description,
        flatRateCents: data.flatRateCents,
        freeShippingThresholdCents: data.freeShippingThresholdCents,
        minDeliveryDays: data.minDeliveryDays,
        maxDeliveryDays: data.maxDeliveryDays,
        sortOrder: data.sortOrder,
        active: data.active,
      },
    });
    await audit(AUDIT_ACTIONS.SHIPPING_METHOD_CREATED, authed, "ShippingMethod", method.id, {
      zone: zone.name,
      name: method.name,
      flatRateCents: method.flatRateCents,
      freeShippingThresholdCents: method.freeShippingThresholdCents,
      minDeliveryDays: method.minDeliveryDays,
      maxDeliveryDays: method.maxDeliveryDays,
      sortOrder: method.sortOrder,
      active: method.active,
    }, meta, db);
    return method;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(`${zone.name} already has a method named "${data.name}". Edit it instead.`);
    }
    throw error;
  }
}

export async function updateShippingMethod(
  actor: Actor,
  id: string,
  input: unknown,
  meta: Meta = {},
  db: Db = prisma,
) {
  const authed = requirePermission(actor, PERMISSION);
  const data = parseInput(shippingMethodUpdateSchema, input);
  const current = await db.shippingMethod.findUnique({ where: { id } });
  if (!current) throw new NotFoundError("Shipping method", id);

  const method = await db.shippingMethod.update({
    where: { id },
    data: {
      description: data.description,
      flatRateCents: data.flatRateCents,
      freeShippingThresholdCents: data.freeShippingThresholdCents,
      minDeliveryDays: data.minDeliveryDays,
      maxDeliveryDays: data.maxDeliveryDays,
      sortOrder: data.sortOrder,
      active: data.active,
    },
  });
  const snapshot = (m: typeof current) => ({
    flatRateCents: m.flatRateCents,
    freeShippingThresholdCents: m.freeShippingThresholdCents,
    minDeliveryDays: m.minDeliveryDays,
    maxDeliveryDays: m.maxDeliveryDays,
    sortOrder: m.sortOrder,
    active: m.active,
  });
  await audit(AUDIT_ACTIONS.SHIPPING_METHOD_UPDATED, authed, "ShippingMethod", id, {
    name: method.name,
    before: snapshot(current),
    after: snapshot(method),
  }, meta, db);
  return method;
}
