"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { ZodError } from "zod";

import { isAuthError } from "@/server/auth/errors";
import { isCatalogError } from "@/server/catalog/errors";
import { cartIdentity } from "@/server/cart/identity";
import { writeCartToken, clearCartToken } from "@/server/cart/cart-cookie";
import { addToCart, removeCartItem, updateCartItem } from "@/server/cart/cart-service";
import { placeOrder, quoteCheckout, type CheckoutQuote } from "@/server/orders/checkout-service";
import { rememberOrder } from "@/server/orders/order-confirmation-cookie";

export type StoreActionResult = { ok: true; message?: string } | { ok: false; error: string };

function firstZodMessage(error: ZodError): string {
  return error.issues[0]?.message ?? "Please check the form and try again.";
}

async function run(fn: () => Promise<void>): Promise<StoreActionResult> {
  try {
    await fn();
    return { ok: true };
  } catch (error) {
    if (isCatalogError(error) || isAuthError(error))
      return { ok: false, error: error.publicMessage };
    if (error instanceof ZodError) return { ok: false, error: firstZodMessage(error) };
    throw error;
  }
}

async function meta() {
  const h = await headers();
  return {
    ipAddress: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: h.get("user-agent"),
  };
}

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}
function optional(form: FormData, key: string): string | undefined {
  return str(form, key) || undefined;
}

export async function addToCartAction(
  _prev: StoreActionResult | null,
  form: FormData,
): Promise<StoreActionResult> {
  const result = await run(async () => {
    const summary = await addToCart(await cartIdentity(), {
      variantId: str(form, "variantId"),
      quantity: Number(str(form, "quantity") || "1"),
    });
    await writeCartToken(summary.token);
  });
  return result;
}

export async function updateCartAction(
  _prev: StoreActionResult | null,
  form: FormData,
): Promise<StoreActionResult> {
  const result = await run(async () => {
    await updateCartItem(await cartIdentity(), {
      variantId: str(form, "variantId"),
      quantity: Number(str(form, "quantity") || "0"),
    });
  });
  return result;
}

export async function removeFromCartAction(
  _prev: StoreActionResult | null,
  form: FormData,
): Promise<StoreActionResult> {
  const result = await run(async () => {
    await removeCartItem(await cartIdentity(), str(form, "variantId"));
  });
  return result;
}

/** Read-only server-recomputed quote for the checkout review (no writes). */
export async function quoteCheckoutAction(input: {
  province?: string;
  shippingMethodId?: string;
}): Promise<CheckoutQuote | null> {
  return quoteCheckout(await cartIdentity(), {
    province: input.province || null,
    shippingMethodId: input.shippingMethodId || null,
  });
}

export async function placeOrderAction(
  _prev: StoreActionResult | null,
  form: FormData,
): Promise<StoreActionResult> {
  let orderNumber: string | null = null;

  const result = await run(async () => {
    const address = {
      firstName: str(form, "firstName"),
      lastName: str(form, "lastName"),
      company: optional(form, "company"),
      line1: str(form, "line1"),
      line2: optional(form, "line2"),
      city: str(form, "city"),
      province: str(form, "province"),
      postalCode: str(form, "postalCode"),
      country: "CA" as const,
      phone: optional(form, "phone"),
    };
    const placed = await placeOrder(
      await cartIdentity(),
      {
        email: str(form, "email"),
        shippingAddress: address,
        shippingMethodId: str(form, "shippingMethodId"),
        customerNote: optional(form, "customerNote"),
      },
      await meta(),
    );
    orderNumber = placed.orderNumber;
    await rememberOrder(placed.orderNumber);
    await clearCartToken();
  });

  if (result.ok && orderNumber) {
    // Phase 7: the order is created PENDING/UNPAID — take payment next.
    redirect(`/checkout/${orderNumber}/payment`);
  }
  return result;
}
