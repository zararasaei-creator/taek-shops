import { z } from "zod";

/**
 * Cart & checkout input schemas (Phase 6). Money is never accepted from the
 * client — prices and totals are always recomputed server-side from the current
 * catalogue. These schemas only cover identifiers, quantities, and the shipping
 * address.
 */

export const MAX_CART_LINE_QUANTITY = 99;

/** A CUID-shaped id (Prisma default). Kept loose but non-empty. */
export const idSchema = z.string().trim().min(1).max(64);

export const cartLineQuantitySchema = z
  .number()
  .int()
  .min(1, "Quantity must be at least 1.")
  .max(MAX_CART_LINE_QUANTITY, `Quantity may not exceed ${MAX_CART_LINE_QUANTITY}.`);

export const addToCartSchema = z.object({
  variantId: idSchema,
  quantity: cartLineQuantitySchema.default(1),
});
export type AddToCartInput = z.infer<typeof addToCartSchema>;

export const updateCartItemSchema = z.object({
  variantId: idSchema,
  /** 0 removes the line. */
  quantity: z.number().int().min(0).max(MAX_CART_LINE_QUANTITY),
});
export type UpdateCartItemInput = z.infer<typeof updateCartItemSchema>;

// ---------------------------------------------------------------------------
// Address
// ---------------------------------------------------------------------------

/** Canadian province / territory codes. The storefront ships within Canada. */
export const CA_PROVINCES = [
  "AB",
  "BC",
  "MB",
  "NB",
  "NL",
  "NS",
  "NT",
  "NU",
  "ON",
  "PE",
  "QC",
  "SK",
  "YT",
] as const;

const postalCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z] ?\d[ABCEGHJ-NPRSTV-Z]\d$/,
    "Enter a valid Canadian postal code (e.g. K1A 0B1).",
  )
  .transform((value) => (value.length === 6 ? `${value.slice(0, 3)} ${value.slice(3)}` : value));

export const checkoutAddressSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  company: z.string().trim().max(120).optional(),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(120),
  province: z.enum(CA_PROVINCES, { error: "Select a province or territory." }),
  postalCode: postalCodeSchema,
  country: z.literal("CA").default("CA"),
  phone: z.string().trim().max(40).optional(),
});
export type CheckoutAddressInput = z.infer<typeof checkoutAddressSchema>;

export const checkoutContactSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address.").max(254),
});

export const placeOrderSchema = z.object({
  email: checkoutContactSchema.shape.email,
  shippingAddress: checkoutAddressSchema,
  /** When omitted, the billing address equals the shipping address. */
  billingAddress: checkoutAddressSchema.optional(),
  shippingMethodId: idSchema,
  customerNote: z.string().trim().max(2000).optional(),
});
export type PlaceOrderInput = z.infer<typeof placeOrderSchema>;
