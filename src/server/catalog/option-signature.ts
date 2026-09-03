/**
 * Deterministic signature for a variant's selected option values.
 *
 * `ProductVariant.optionSignature` stores this, and `@@unique([productId,
 * optionSignature])` then makes two variants of the same product with the same
 * option combination impossible at the database level. A product with no options
 * has exactly one variant whose signature is the empty string.
 */
export function optionSignature(optionValueIds: readonly string[]): string {
  return [...new Set(optionValueIds)].sort().join("|");
}
