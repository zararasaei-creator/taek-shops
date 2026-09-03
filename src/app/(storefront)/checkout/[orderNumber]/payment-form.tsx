"use client";

import { useMemo, useState } from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";

import { Button } from "@/components/ui/button";
import { formatCents } from "@/server/domain/money";

const stripeCache = new Map<string, Promise<Stripe | null>>();
function getStripe(publishableKey: string): Promise<Stripe | null> {
  let p = stripeCache.get(publishableKey);
  if (!p) {
    p = loadStripe(publishableKey);
    stripeCache.set(publishableKey, p);
  }
  return p;
}

interface Props {
  orderNumber: string;
  clientSecret: string;
  publishableKey: string;
  amountCents: number;
}

export function PaymentForm({ orderNumber, clientSecret, publishableKey, amountCents }: Props) {
  const stripePromise = useMemo(() => getStripe(publishableKey), [publishableKey]);

  return (
    <Elements stripe={stripePromise} options={{ clientSecret, appearance: { theme: "stripe" } }}>
      <InnerForm orderNumber={orderNumber} amountCents={amountCents} />
    </Elements>
  );
}

function InnerForm({ orderNumber, amountCents }: { orderNumber: string; amountCents: number }) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);

    const { error: submitError } = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/checkout/${orderNumber}/complete`,
      },
    });

    // Only reached when confirmation fails *before* the redirect (e.g. a
    // validation or immediate card error). A real success redirects to the
    // return_url, where the server verifies the payment authoritatively.
    if (submitError) {
      setError(submitError.message ?? "Payment could not be completed.");
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="mt-6 flex max-w-md flex-col gap-4"
      data-testid="payment-form"
    >
      <PaymentElement />
      <Button type="submit" disabled={!stripe || submitting}>
        {submitting ? "Processing…" : `Pay ${formatCents(amountCents)}`}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-red-600" data-testid="payment-error">
          {error}
        </p>
      ) : null}
      <p className="text-xs text-zinc-500">
        Payments are processed by Stripe. Card details never touch Taek Shops&rsquo; servers.
      </p>
    </form>
  );
}
