import { getCurrentUser } from "@/server/auth";
import { readCartToken } from "@/server/cart/cart-cookie";
import type { CartIdentity } from "@/server/cart/cart-service";

/** Resolve the current shopper: their cart cookie token + (if signed in) user id. */
export async function cartIdentity(): Promise<CartIdentity> {
  const [token, user] = await Promise.all([readCartToken(), getCurrentUser()]);
  return { token: token ?? null, userId: user?.id ?? null };
}
