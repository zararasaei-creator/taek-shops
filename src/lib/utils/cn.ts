export type ClassValue = string | number | null | false | undefined;

/**
 * Minimal class-name joiner. Phase 1 keeps this dependency-free; a later phase can
 * swap in `clsx` + `tailwind-merge` if conflict resolution becomes necessary.
 */
export function cn(...values: ClassValue[]): string {
  return values.filter((value): value is string | number => Boolean(value)).join(" ");
}
