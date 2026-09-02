import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";

type Variant = "primary" | "secondary";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
}

const base =
  "inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium " +
  "transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 " +
  "focus-visible:outline-blue-600 disabled:pointer-events-none disabled:opacity-50";

const variants: Record<Variant, string> = {
  primary: "bg-blue-600 text-white hover:bg-blue-700",
  secondary:
    "border border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50 dark:hover:bg-zinc-800",
};

/**
 * Accessible button primitive. Seed of the shared component system; real design
 * tokens and additional variants arrive in the component-system phase.
 */
export function Button({ variant = "primary", className, type, ...props }: ButtonProps) {
  return (
    <button type={type ?? "button"} className={cn(base, variants[variant], className)} {...props} />
  );
}
