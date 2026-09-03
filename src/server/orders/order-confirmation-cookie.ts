import { cookies } from "next/headers";

import { baseCookieOptions } from "@/server/auth/config";

/**
 * After a guest places an order we drop its number into a first-party
 * `httpOnly` cookie so the confirmation page can be shown without the order
 * number being a public capability (it is not enough to know a number — it must
 * be one this browser just placed, or the viewer must own it / be staff).
 */
const ORDER_COOKIE_NAME = "taek_orders";
const ORDER_COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days
const MAX_REMEMBERED = 10;

export async function rememberOrder(orderNumber: string): Promise<void> {
  const jar = await cookies();
  const current = (jar.get(ORDER_COOKIE_NAME)?.value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const next = [orderNumber, ...current.filter((n) => n !== orderNumber)].slice(0, MAX_REMEMBERED);
  jar.set(ORDER_COOKIE_NAME, next.join(","), {
    ...baseCookieOptions(),
    httpOnly: true,
    maxAge: ORDER_COOKIE_MAX_AGE,
  });
}

export async function remembersOrder(orderNumber: string): Promise<boolean> {
  const jar = await cookies();
  return (jar.get(ORDER_COOKIE_NAME)?.value ?? "")
    .split(",")
    .map((s) => s.trim())
    .includes(orderNumber);
}
