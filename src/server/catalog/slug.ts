/**
 * Slug generation and validation for catalogue entities.
 *
 * A slug is lower-case, ASCII, hyphen-separated, 1-120 chars, no leading/trailing
 * or doubled hyphens. It is the public URL identifier and, for products, a stable
 * secondary key used by the importer.
 */

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MAX_LENGTH = 120;

/**
 * Best-effort conversion of arbitrary text into a valid slug.
 *
 * NFKD normalisation splits accented letters into a base letter plus a combining
 * mark; the base letter survives and every non-`[a-z0-9]` run (marks, spaces,
 * punctuation) collapses to a single hyphen.
 */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
}

export function isValidSlug(value: string): boolean {
  return value.length >= 1 && value.length <= SLUG_MAX_LENGTH && SLUG_PATTERN.test(value);
}

/**
 * Normalise a caller-supplied slug: keep it if already valid, otherwise slugify
 * it. Throws only if the result is empty (e.g. input was all punctuation).
 */
export function normalizeSlug(value: string): string {
  const trimmed = value.trim();
  const candidate = isValidSlug(trimmed) ? trimmed : slugify(trimmed);
  if (!candidate) {
    throw new Error(`Cannot derive a valid slug from "${value}".`);
  }
  return candidate;
}
