"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";

export type ActionResult = { ok: true; id?: string } | { ok: false; error: string };

interface ActionFormProps {
  action: (prev: ActionResult | null, form: FormData) => Promise<ActionResult>;
  submitLabel: string;
  children: React.ReactNode;
  successMessage?: string;
  className?: string;
}

/**
 * Thin wrapper around `useActionState` for the admin forms: renders children,
 * a submit button, and the action's error / success message.
 */
export function ActionForm({
  action,
  submitLabel,
  children,
  successMessage = "Saved.",
  className,
}: ActionFormProps) {
  const [state, formAction, pending] = useActionState(action, null);

  return (
    <form action={formAction} className={className ?? "flex flex-col gap-3"}>
      {children}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Working…" : submitLabel}
        </Button>
        {state?.ok === false ? (
          <span role="alert" className="text-sm text-red-600">
            {state.error}
          </span>
        ) : null}
        {state?.ok === true ? (
          <span role="status" className="text-sm text-green-700">
            {successMessage}
          </span>
        ) : null}
      </div>
    </form>
  );
}

export function Field({
  label,
  name,
  type = "text",
  defaultValue,
  required,
  placeholder,
  help,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string | number;
  required?: boolean;
  placeholder?: string;
  help?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">
        {label}
        {required ? <span className="text-red-600"> *</span> : null}
      </span>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue}
        required={required}
        placeholder={placeholder}
        className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
      />
      {help ? <span className="text-xs text-zinc-500">{help}</span> : null}
    </label>
  );
}

export function TextArea({
  label,
  name,
  defaultValue,
}: {
  label: string;
  name: string;
  defaultValue?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <textarea
        name={name}
        defaultValue={defaultValue}
        rows={3}
        className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
      />
    </label>
  );
}

export function Select({
  label,
  name,
  options,
  defaultValue,
}: {
  label: string;
  name: string;
  options: { value: string; label: string }[];
  defaultValue?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <select
        name={name}
        defaultValue={defaultValue}
        className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
