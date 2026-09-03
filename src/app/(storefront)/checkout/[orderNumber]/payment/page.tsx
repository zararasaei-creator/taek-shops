import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { headers } from "next/headers";

import { Container } from "@/components/ui/container";
import { getCurrentUser } from "@/server/auth";
import { isCatalogError } from "@/server/catalog/errors";
import { remembersOrder } from "@/server/orders/order-confirmation-cookie";
import { startPayment } from "@/server/orders/payment-service";
import { PaymentForm } from "@/app/(storefront)/checkout/[orderNumber]/payment-form";

export const dynamic = "force-dynamic";

export default async function PaymentPage({
  params,
}: PageProps<"/checkout/[orderNumber]/payment">) {
  const { orderNumber } = await params;
  const [user, justPlaced, h] = await Promise.all([
    getCurrentUser(),
    remembersOrder(orderNumber),
    headers(),
  ]);

  let start;
  try {
    start = await startPayment(
      orderNumber,
      { user, justPlaced },
      {
        ipAddress: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
        userAgent: h.get("user-agent"),
      },
    );
  } catch (error) {
    if (isCatalogError(error) && error.code === "not_found") notFound();
    if (isCatalogError(error)) {
      return (
        <Container className="py-12">
          <h1 className="text-2xl font-semibold">Payment unavailable</h1>
          <p className="mt-3 text-zinc-600 dark:text-zinc-300">{error.publicMessage}</p>
          <Link
            href={`/checkout/confirmation/${orderNumber}`}
            className="mt-6 inline-block text-sm text-blue-600"
          >
            View order status →
          </Link>
        </Container>
      );
    }
    throw error;
  }

  if (start.alreadyPaid) redirect(`/checkout/confirmation/${orderNumber}`);

  return (
    <Container className="py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Payment</h1>
      <p className="mt-2 text-zinc-600 dark:text-zinc-300">
        Order <strong>{orderNumber}</strong> — no charge is made until you confirm below.
      </p>
      <PaymentForm
        orderNumber={orderNumber}
        clientSecret={start.clientSecret}
        publishableKey={start.publishableKey}
        amountCents={start.amountCents}
      />
    </Container>
  );
}
