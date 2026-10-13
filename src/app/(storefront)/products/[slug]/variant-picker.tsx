"use client";

import { useMemo, useState } from "react";

import { formatCents } from "@/server/domain/money";
import { addToCartAction } from "@/app/(storefront)/actions";
import { StoreForm } from "@/app/(storefront)/store-form";
import type { PublicProduct } from "@/server/catalog/catalog-queries";

interface VariantPickerProps {
  variants: PublicProduct["variants"];
}

function comboKey(options: { option: string; value: string }[]): string {
  return [...options]
    .map((o) => `${o.option}=${o.value}`)
    .sort()
    .join("|");
}

/**
 * Resolves the shopper's option picks (Size, Colour, ...) to a single real
 * variant, then hands that variant's actual id to the unchanged
 * `addToCartAction` — cart/checkout/payment code only ever sees a `variantId`,
 * exactly as it did with the old one-row-per-variant list.
 */
export function VariantPicker({ variants }: VariantPickerProps) {
  const optionGroups = useMemo(() => {
    const order: string[] = [];
    const values = new Map<string, string[]>();
    for (const variant of variants) {
      for (const { option, value } of variant.options) {
        if (!values.has(option)) {
          values.set(option, []);
          order.push(option);
        }
        const list = values.get(option)!;
        if (!list.includes(value)) list.push(value);
      }
    }
    return order.map((option) => ({ option, values: values.get(option)! }));
  }, [variants]);

  const byCombo = useMemo(() => {
    const map = new Map<string, PublicProduct["variants"][number]>();
    for (const variant of variants) map.set(comboKey(variant.options), variant);
    return map;
  }, [variants]);

  const [selected, setSelected] = useState<Record<string, string>>(() => {
    const first = variants[0];
    const initial: Record<string, string> = {};
    if (first) for (const { option, value } of first.options) initial[option] = value;
    return initial;
  });

  const resolvedVariant =
    optionGroups.length > 0 && optionGroups.every((g) => selected[g.option])
      ? byCombo.get(
          comboKey(optionGroups.map((g) => ({ option: g.option, value: selected[g.option]! }))),
        )
      : variants.length === 1
        ? variants[0]
        : undefined;

  if (optionGroups.length === 0) {
    const only = variants[0];
    if (!only) return null;
    return (
      <div
        className="mt-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
        data-testid="variant-picker"
      >
        <p className="text-sm text-zinc-500">
          {formatCents(only.priceCents)} · SKU {only.sku}
        </p>
        <StoreForm
          action={addToCartAction}
          submitLabel="Add to cart"
          pendingLabel="Adding…"
          className="mt-3 flex items-center gap-2"
          hidden={{ variantId: only.id, quantity: "1" }}
        />
      </div>
    );
  }

  return (
    <div className="mt-4 flex flex-col gap-4" data-testid="variant-picker">
      {optionGroups.map((group) => (
        <div key={group.option}>
          <p className="text-sm font-medium">{group.option}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {group.values.map((value) => {
              const isSelected = selected[group.option] === value;
              return (
                <button
                  key={value}
                  type="button"
                  data-testid={`variant-option-${group.option}-${value}`}
                  aria-pressed={isSelected}
                  onClick={() => setSelected((prev) => ({ ...prev, [group.option]: value }))}
                  className={`rounded-md border px-3 py-1.5 text-sm ${
                    isSelected
                      ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                      : "border-zinc-300 dark:border-zinc-700"
                  }`}
                >
                  {value}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
        {resolvedVariant ? (
          <p className="text-sm text-zinc-500" data-testid="variant-picker-price">
            {formatCents(resolvedVariant.priceCents)} · SKU {resolvedVariant.sku}
          </p>
        ) : (
          <p className="text-sm text-red-600">This combination isn&apos;t available.</p>
        )}
        <StoreForm
          action={addToCartAction}
          submitLabel="Add to cart"
          pendingLabel="Adding…"
          className="mt-3 flex items-center gap-2"
          hidden={{ variantId: resolvedVariant?.id ?? "", quantity: "1" }}
          disabled={!resolvedVariant}
        />
      </div>
    </div>
  );
}
