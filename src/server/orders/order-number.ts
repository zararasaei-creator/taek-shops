import { randomInt } from "node:crypto";

import type { Prisma } from "@prisma/client";

/**
 * Human-friendly, unguessable order number: `TS-YYYYMMDD-XXXXXX` where the
 * suffix is 6 Crockford-base32 characters (no I/L/O/U). Collisions are retried
 * against the unique `Order.orderNumber` index.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function randomSuffix(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

export async function generateOrderNumber(
  db: Pick<Prisma.TransactionClient, "order">,
  now: Date = new Date(),
): Promise<string> {
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, "");
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = `TS-${datePart}-${randomSuffix()}`;
    const clash = await db.order.findUnique({
      where: { orderNumber: candidate },
      select: { id: true },
    });
    if (!clash) return candidate;
  }
  throw new Error("Could not allocate a unique order number after 8 attempts.");
}
