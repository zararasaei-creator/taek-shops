"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";

export type StoreActionResult = { ok: true; message?: string } | { ok: false; error: string };

interface StoreFormProps {
  action: (prev: StoreActionResult | null, form: FormData) => Promise<StoreActionResult>;
  submitLabel: string;
  pendingLabel?: string;
  children?: React.ReactNode;
  hidden?: Record<string, string>;
  variant?: "primary" | "secondary";
  className?: string;
}

/** Storefront form bound to a server action, with inline error rendering. */
export function StoreForm({
  action,
  submitLabel,
  pendingLabel,
  children,
  hidden,
  variant = "primary",
  className,
}: StoreFormProps) {
  const [state, formAction, pending] = useActionState(action, null);

  return (
    <form action={formAction} className={className ?? "flex flex-col gap-3"}>
      {hidden
        ? Object.entries(hidden).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))
        : null}
      {children}
      <Button type="submit" variant={variant} disabled={pending}>
        {pending ? (pendingLabel ?? "Working…") : submitLabel}
      </Button>
      {state?.ok === false ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
