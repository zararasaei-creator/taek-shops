import { StripePaymentGateway } from "@/server/domain/payments/stripe";
import type { PaymentGateway } from "@/server/domain/payments/payment-gateway";

export * from "@/server/domain/payments/payment-gateway";

let gateway: PaymentGateway | null = null;

/** The active payment gateway. Swap point for a different provider. */
export function getPaymentGateway(): PaymentGateway {
  if (!gateway) gateway = new StripePaymentGateway();
  return gateway;
}

/** Test seam. */
export function __setPaymentGateway(next: PaymentGateway | null): void {
  gateway = next;
}
