import { cookies } from "next/headers";

import { baseCookieOptions } from "@/server/auth/config";

/**
 * The guest cart is identified by an opaque token in a first-party cookie. It is
 * not a credential (it only names a shopping cart) but is `httpOnly` so page
 * scripts cannot read or forge it.
 */
export const CART_COOKIE_NAME = "taek_cart";
const CART_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export async function readCartToken(): Promise<string | undefined> {
  return (await cookies()).get(CART_COOKIE_NAME)?.value || undefined;
}

export async function writeCartToken(token: string): Promise<void> {
  (await cookies()).set(CART_COOKIE_NAME, token, {
    ...baseCookieOptions(),
    httpOnly: true,
    maxAge: CART_COOKIE_MAX_AGE,
  });
}

export async function clearCartToken(): Promise<void> {
  (await cookies()).set(CART_COOKIE_NAME, "", {
    ...baseCookieOptions(),
    httpOnly: true,
    maxAge: 0,
  });
}
