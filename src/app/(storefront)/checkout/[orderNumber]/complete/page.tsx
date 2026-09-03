import Link from "next/link";
import { notFound } from "next/navigation";

import { Container } from "@/components/ui/container";
import { getCurrentUser } from "@/server/auth";
import { isCatalogError } from "@/server/catalog/errors";
import { remembersOrder } from "@/server/orders/order-confirmation-cookie";
import { verifyPaymentStatus } from "@/server/orders/payment-service";

export const dynamic = "force-dynamic";

/**
 * Stripe redirects here after `confirmPayment`. We do NOT trust the redirect's
 * `redirect_status` query param — `verifyPaymentStatus` asks Stripe directly and
 * runs the same idempotent finalize the webhook uses.
 */
export default async function CompletePage({
  params,
}: PageProps<"/checkout/[orderNumber]/complete">) {
  const { orderNumber } = await params;
  const [user, justPlaced] = await Promise.all([getCurrentUser(), remembersOrder(orderNumber)]);

  let view;
  try {
    view = await verifyPaymentStatus(orderNumber, { user, justPlaced });
  } catch (error) {
    if (isCatalogError(error) && error.code === "not_found") notFound();
    throw error;
  }

  const paid = view.paymentStatus === "PAID";
  const failed = view.paymentStatus === "FAILED";

  return (
    <Container className="py-12">
      {paid ? (
        <>
          <p className="text-sm text-green-700" data-testid="payment-result">
            Payment received
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Payment successful</h1>
          <p className="mt-2 text-zinc-600 dark:text-zinc-300">
            Order <strong>{view.orderNumber}</strong> is confirmed.
          </p>
          <Link
            href={`/checkout/confirmation/${view.orderNumber}`}
            className="mt-6 inline-block rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-blue-700"
            data-testid="to-confirmation"
          >
            View your order
          </Link>
        </>
      ) : failed ? (
        <>
          <p className="text-sm text-red-700" data-testid="payment-result">
            Payment failed
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Payment was not completed</h1>
          <p className="mt-2 text-zinc-600 dark:text-zinc-300">
            Order <strong>{view.orderNumber}</strong> has been cancelled and any held stock
            released. Please place a new order to try again.
          </p>
          <Link href="/" className="mt-6 inline-block text-sm text-blue-600">
            Continue shopping →
          </Link>
        </>
      ) : (
        <>
          <p className="text-sm text-zinc-600" data-testid="payment-result">
            Payment processing
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Confirming your payment…</h1>
          <p className="mt-2 text-zinc-600 dark:text-zinc-300">
            This can take a few seconds. Order <strong>{view.orderNumber}</strong>.
          </p>
          <Link
            href={`/checkout/${view.orderNumber}/complete`}
            className="mt-6 inline-block rounded-md border border-zinc-300 px-5 py-2.5 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Check again
          </Link>
        </>
      )}
    </Container>
  );
}
