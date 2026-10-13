import { z } from "zod";

import { CA_PROVINCES } from "@/lib/validation/checkout";
import { MoneyError, parseAmountToCents } from "@/server/domain/money";

/**
 * Input schemas for the admin tax / shipping configuration (Phase 11).
 *
 * Everything arrives from HTML forms as strings. Units are explicit:
 *  - tax rates are PERCENT ("13", "9.975"; up to 4 decimals) and converted to
 *    the stored exact fraction (`TaxRate.rate`, 0.130000 == 13%);
 *  - money is DOLLARS in CAD ("12.50"), parsed to integer cents with the
 *    shared `parseAmountToCents` (never a float);
 *  - dates are `YYYY-MM-DD`, interpreted as UTC (start of day for "from",
 *    end of day for "to").
 * There are deliberately NO defaults for a rate or a shipping price: an empty
 * field is a validation error, so a blank form can never create a 0% tax rate
 * or free shipping by accident.
 */

const PROVINCE_OR_COUNTRY_WIDE = z.enum([...CA_PROVINCES, ""] as [string, ...string[]], {
  error: "Choose a province/territory, or country-wide.",
});

const nameSchema = (label: string, max: number) =>
  z.string().trim().min(1, `${label} is required.`).max(max, `${label} must be at most ${max} characters.`);

export const percentSchema = z
  .string({ error: "Rate is required." })
  .trim()
  .regex(/^\d{1,3}(\.\d{1,4})?$/, "Enter the rate as a percent, e.g. 13 or 9.975 (up to 4 decimals).")
  .refine((v) => Number(v) <= 100, "A rate cannot exceed 100%.");

const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD.");

/** "" / missing → null; a valid date → a UTC Date (start or end of that day). */
function optionalDate(edge: "start" | "end") {
  return z
    .union([z.literal(""), isoDate])
    .optional()
    .transform((value, ctx) => {
      if (!value) return null;
      const date = new Date(`${value}T${edge === "start" ? "00:00:00.000" : "23:59:59.999"}Z`);
      // `Date` silently rolls 2026-02-30 over to March 2 — require an exact round trip.
      if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
        ctx.addIssue({ code: "custom", message: "Not a valid calendar date." });
        return z.NEVER;
      }
      return date;
    });
}

const checkbox = z.boolean();

function parseDollars(value: string, label: string, ctx: z.RefinementCtx): number {
  try {
    const cents = parseAmountToCents(value);
    if (cents < 0) {
      ctx.addIssue({ code: "custom", message: `${label} cannot be negative.` });
      return z.NEVER;
    }
    if (cents > MAX_SHIPPING_CENTS) {
      ctx.addIssue({ code: "custom", message: `${label} is unreasonably large.` });
      return z.NEVER;
    }
    return cents;
  } catch (error) {
    if (error instanceof MoneyError) {
      ctx.addIssue({ code: "custom", message: `${label}: enter CAD dollars, e.g. 12.50.` });
      return z.NEVER;
    }
    throw error;
  }
}

/** Required dollars → integer cents. Blank is an error: there is no default price. */
function requiredDollars(label: string) {
  return z.string({ error: `${label} is required.` }).trim().transform((value, ctx) => {
    if (value === "") {
      ctx.addIssue({ code: "custom", message: `${label} is required (CAD dollars, e.g. 12.50).` });
      return z.NEVER;
    }
    return parseDollars(value, label, ctx);
  });
}

/** Optional dollars → cents, or null when left blank. */
function optionalDollars(label: string) {
  return z.string().trim().optional().transform((value, ctx) => {
    if (!value) return null;
    return parseDollars(value, label, ctx);
  });
}

/** $10,000.00 — a sanity ceiling, not a business rule. */
export const MAX_SHIPPING_CENTS = 1_000_000;

// ---- Tax --------------------------------------------------------------------

export const taxRegionCreateSchema = z.object({
  name: nameSchema("Name", 80),
  province: PROVINCE_OR_COUNTRY_WIDE,
  active: checkbox.default(true),
});

export const taxRegionUpdateSchema = z.object({
  name: nameSchema("Name", 80),
  active: checkbox,
});

const rateFields = {
  ratePercent: percentSchema,
  priority: z.coerce.number({ error: "Priority must be a whole number." }).int().min(0).max(1000),
  compound: checkbox,
  active: checkbox,
  effectiveFrom: optionalDate("start"),
  effectiveTo: optionalDate("end"),
};

function orderedDates<T extends { effectiveFrom: Date | null; effectiveTo: Date | null }>(v: T) {
  return !v.effectiveFrom || !v.effectiveTo || v.effectiveFrom <= v.effectiveTo;
}
const ORDER_MESSAGE = { message: "“Effective to” must not be before “effective from”.", path: ["effectiveTo"] };

export const taxRateCreateSchema = z
  .object({
    regionId: z.string().min(1),
    name: nameSchema("Tax name", 40),
    taxCategory: z.string().trim().max(60).default(""),
    ...rateFields,
  })
  .refine(orderedDates, ORDER_MESSAGE);

export const taxRateUpdateSchema = z.object(rateFields).refine(orderedDates, ORDER_MESSAGE);

// ---- Shipping ---------------------------------------------------------------

export const shippingZoneCreateSchema = z.object({
  name: nameSchema("Zone name", 80),
  active: checkbox.default(true),
});

export const shippingZoneUpdateSchema = z.object({
  name: nameSchema("Zone name", 80),
  active: checkbox,
});

export const shippingZoneRegionSchema = z.object({
  zoneId: z.string().min(1),
  province: PROVINCE_OR_COUNTRY_WIDE,
});

const optionalDays = z
  .union([z.literal(""), z.coerce.number().int().min(0).max(365)])
  .optional()
  .transform((v) => (v === "" || v === undefined ? null : v));

const methodFields = {
  description: z.string().trim().max(300).optional().transform((v) => v || null),
  flatRateCents: requiredDollars("Shipping price"),
  freeShippingThresholdCents: optionalDollars("Free-shipping threshold"),
  minDeliveryDays: optionalDays,
  maxDeliveryDays: optionalDays,
  sortOrder: z.coerce.number({ error: "Sort order must be a whole number." }).int().min(0).max(10_000),
  active: checkbox,
};

function orderedDays<T extends { minDeliveryDays: number | null; maxDeliveryDays: number | null }>(v: T) {
  return v.minDeliveryDays === null || v.maxDeliveryDays === null || v.minDeliveryDays <= v.maxDeliveryDays;
}
const DAYS_MESSAGE = { message: "Minimum delivery days cannot exceed maximum.", path: ["maxDeliveryDays"] };

export const shippingMethodCreateSchema = z
  .object({ zoneId: z.string().min(1), name: nameSchema("Method name", 80), ...methodFields })
  .refine(orderedDays, DAYS_MESSAGE);

export const shippingMethodUpdateSchema = z.object(methodFields).refine(orderedDays, DAYS_MESSAGE);
