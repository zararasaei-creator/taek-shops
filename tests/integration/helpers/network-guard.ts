import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

import { vi, type MockInstance } from "vitest";

import { StripePaymentGateway } from "@/server/domain/payments/stripe";

/**
 * Proves a test made NO external request — an invalid key or a fake default
 * alone cannot, because the real transport could still be attempted and merely
 * fail. This replaces every layer a Stripe call could leave through with a
 * spy that RECORDS the attempt and throws instead of connecting, so nothing
 * ever leaves the machine:
 *  - the real Stripe adapter's methods (`StripePaymentGateway.prototype.*`) —
 *    the application's own transport boundary;
 *  - `http(s).request/get` — the stripe-node SDK's default Node transport;
 *  - global `fetch` — the SDK's alternative transport;
 *  - `net.connect` / `tls.connect` — the lowest level, in case something else
 *    opens a socket. (Prisma's query engine talks to Postgres inside its native
 *    library, not through these, so database access is unaffected.)
 * `attempts` must be empty at the end of the guarded tests.
 */
export interface NetworkGuard {
  readonly attempts: string[];
  restore(): void;
}

export function installNetworkGuard(): NetworkGuard {
  const attempts: string[] = [];
  const spies: MockInstance[] = [];
  const block = (label: string) => () => {
    attempts.push(label);
    throw new Error(`[network-guard] external network access blocked: ${label}`);
  };

  const proto = StripePaymentGateway.prototype as unknown as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === "constructor" || typeof proto[name] !== "function") continue;
    spies.push(
      (vi.spyOn(proto as Record<string, () => unknown>, name) as MockInstance).mockImplementation(
        block(`StripePaymentGateway.${name}`) as never,
      ),
    );
  }
  spies.push(vi.spyOn(http, "request").mockImplementation(block("http.request") as never));
  spies.push(vi.spyOn(http, "get").mockImplementation(block("http.get") as never));
  spies.push(vi.spyOn(https, "request").mockImplementation(block("https.request") as never));
  spies.push(vi.spyOn(https, "get").mockImplementation(block("https.get") as never));
  spies.push(vi.spyOn(globalThis, "fetch").mockImplementation(block("fetch") as never));
  spies.push(vi.spyOn(net, "connect").mockImplementation(block("net.connect") as never));
  spies.push(vi.spyOn(tls, "connect").mockImplementation(block("tls.connect") as never));

  return {
    attempts,
    restore() {
      for (const spy of spies) spy.mockRestore();
    },
  };
}
