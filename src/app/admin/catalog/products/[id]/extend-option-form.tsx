"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/components/admin/action-form";

export interface BackfillTarget {
  id: string;
  label: string;
}

interface ExtendOptionFormProps {
  action: (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;
  variants: BackfillTarget[];
}

function parseValues(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * Add a brand-new option to a product that already has variants. Unlike the
 * zero-variant "add option" form, every existing variant needs a value for the
 * new option before it can be saved (the server enforces this atomically) —
 * so this renders one backfill selector per existing variant, populated from
 * the values typed above.
 */
export function ExtendOptionForm({ action, variants }: ExtendOptionFormProps) {
  const [state, formAction, pending] = useActionState(action, null);
  const [valuesText, setValuesText] = useState("");
  const values = parseValues(valuesText);

  return (
    <form action={formAction} className="mt-3 flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">
          Option name<span className="text-red-600"> *</span>
        </span>
        <input
          name="name"
          required
          placeholder="Colour"
          className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">
          Values<span className="text-red-600"> *</span>
        </span>
        <textarea
          name="values"
          required
          rows={2}
          value={valuesText}
          onChange={(event) => setValuesText(event.target.value)}
          placeholder="White, Black, Red"
          className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        />
        <span className="text-xs text-zinc-500">Comma- or newline-separated.</span>
      </label>

      {variants.length > 0 ? (
        <div className="rounded border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950">
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
            This product has {variants.length} existing variant{variants.length === 1 ? "" : "s"}.
            Choose a value for each so none of them ends up missing this option.
          </p>
          <div className="mt-2 flex flex-col gap-2">
            {variants.map((variant) => (
              <label key={variant.id} className="flex items-center justify-between gap-3 text-xs">
                <span className="font-mono">{variant.label}</span>
                <select
                  name={`backfill_${variant.id}`}
                  required
                  disabled={values.length === 0}
                  defaultValue=""
                  className="rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                >
                  <option value="" disabled>
                    {values.length === 0 ? "type values above" : "— choose —"}
                  </option>
                  {values.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Working…" : "Add option"}
        </Button>
        {state?.ok === false ? (
          <span role="alert" className="text-sm text-red-600">
            {state.error}
          </span>
        ) : null}
        {state?.ok === true ? (
          <span role="status" className="text-sm text-green-700">
            Option added.
          </span>
        ) : null}
      </div>
    </form>
  );
}
