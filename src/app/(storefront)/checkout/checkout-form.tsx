"use client";

import { useActionState, useEffect, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { formatCents } from "@/server/domain/money";
import { CA_PROVINCES } from "@/lib/validation/checkout";
import type { CheckoutQuote } from "@/server/orders/checkout-service";
import {
  placeOrderAction,
  quoteCheckoutAction,
  type StoreActionResult,
} from "@/app/(storefront)/actions";

const PROVINCE_LABELS: Record<(typeof CA_PROVINCES)[number], string> = {
  AB: "Alberta",
  BC: "British Columbia",
  MB: "Manitoba",
  NB: "New Brunswick",
  NL: "Newfoundland and Labrador",
  NS: "Nova Scotia",
  NT: "Northwest Territories",
  NU: "Nunavut",
  ON: "Ontario",
  PE: "Prince Edward Island",
  QC: "Quebec",
  SK: "Saskatchewan",
  YT: "Yukon",
};

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? "text-base font-semibold" : "text-sm"}`}>
      <span>{label}</span>
      <span className="tabular-nums" data-testid={`review-${label.toLowerCase()}`}>
        {value}
      </span>
    </div>
  );
}

export function CheckoutForm({ initialQuote }: { initialQuote: CheckoutQuote }) {
  const [state, formAction, submitting] = useActionState<StoreActionResult | null, FormData>(
    placeOrderAction,
    null,
  );

  const [province, setProvince] = useState<string>("ON");
  const [methodId, setMethodId] = useState<string>(initialQuote.selectedShipping?.methodId ?? "");
  const [quote, setQuote] = useState<CheckoutQuote>(initialQuote);
  const [, startQuote] = useTransition();

  useEffect(() => {
    startQuote(async () => {
      const next = await quoteCheckoutAction({ province, shippingMethodId: methodId });
      if (next) {
        setQuote(next);
        if (!next.shippingOptions.some((o) => o.methodId === methodId)) {
          setMethodId(next.selectedShipping?.methodId ?? "");
        }
      }
    });
  }, [province, methodId]);

  const options = quote.shippingOptions;

  return (
    <form action={formAction} className="mt-8 grid gap-10 lg:grid-cols-[1fr_20rem]">
      <div className="flex flex-col gap-6">
        <fieldset className="flex flex-col gap-3">
          <legend className="text-lg font-medium">Contact</legend>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Email</span>
            <input
              name="email"
              type="email"
              required
              autoComplete="email"
              className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className="text-lg font-medium">Shipping address</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Text name="firstName" label="First name" required autoComplete="given-name" />
            <Text name="lastName" label="Last name" required autoComplete="family-name" />
          </div>
          <Text name="company" label="Company (optional)" />
          <Text name="line1" label="Address" required autoComplete="address-line1" />
          <Text
            name="line2"
            label="Apartment, suite, etc. (optional)"
            autoComplete="address-line2"
          />
          <div className="grid gap-3 sm:grid-cols-3">
            <Text name="city" label="City" required autoComplete="address-level2" />
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium">Province</span>
              <select
                name="province"
                value={province}
                onChange={(e) => setProvince(e.target.value)}
                className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
              >
                {CA_PROVINCES.map((code) => (
                  <option key={code} value={code}>
                    {PROVINCE_LABELS[code]}
                  </option>
                ))}
              </select>
            </label>
            <Text name="postalCode" label="Postal code" required autoComplete="postal-code" />
          </div>
          <Text name="phone" label="Phone (optional)" autoComplete="tel" />
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className="text-lg font-medium">Shipping method</legend>
          {options.length === 0 ? (
            <p className="text-sm text-red-600">No shipping options for this province.</p>
          ) : (
            options.map((o) => (
              <label
                key={o.methodId}
                className="flex items-center justify-between gap-3 rounded-md border border-zinc-300 p-3 text-sm dark:border-zinc-700"
              >
                <span className="flex items-center gap-3">
                  <input
                    type="radio"
                    name="shippingMethodId"
                    value={o.methodId}
                    checked={methodId === o.methodId}
                    onChange={() => setMethodId(o.methodId)}
                    required
                  />
                  <span>
                    {o.name}
                    {o.minDeliveryDays && o.maxDeliveryDays ? (
                      <span className="text-zinc-500">
                        {" "}
                        · {o.minDeliveryDays}–{o.maxDeliveryDays} business days
                      </span>
                    ) : null}
                  </span>
                </span>
                <span className="tabular-nums">{o.free ? "Free" : formatCents(o.priceCents)}</span>
              </label>
            ))
          )}
        </fieldset>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Order note (optional)</span>
          <textarea
            name="customerNote"
            rows={2}
            className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
      </div>

      <aside className="h-max rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
        <h2 className="text-lg font-medium">Order review</h2>
        <ul className="mt-3 flex flex-col gap-1 text-sm">
          {quote.lines.map((l) => (
            <li key={l.variantId} className="flex justify-between">
              <span className="truncate">
                {l.productName} × {l.quantity}
              </span>
              <span className="tabular-nums">{formatCents(l.lineSubtotalCents)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex flex-col gap-1 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <Row label="Subtotal" value={formatCents(quote.subtotalCents)} />
          <Row label="Shipping" value={formatCents(quote.shippingCents)} />
          <Row label="Tax" value={formatCents(quote.taxCents)} />
          <div className="mt-2 border-t border-zinc-200 pt-2 dark:border-zinc-800">
            <Row label="Total" value={formatCents(quote.totalCents)} strong />
          </div>
        </div>

        <Button type="submit" className="mt-5 w-full" disabled={submitting || options.length === 0}>
          {submitting ? "Placing order…" : "Place order"}
        </Button>
        {state?.ok === false ? (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {state.error}
          </p>
        ) : null}
        <p className="mt-3 text-xs text-zinc-500">
          No payment is taken in this phase — the order is created in a pending state.
        </p>
      </aside>
    </form>
  );
}

function Text({
  name,
  label,
  required,
  autoComplete,
}: {
  name: string;
  label: string;
  required?: boolean;
  autoComplete?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">
        {label}
        {required ? <span className="text-red-600"> *</span> : null}
      </span>
      <input
        name={name}
        required={required}
        autoComplete={autoComplete}
        className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
      />
    </label>
  );
}
