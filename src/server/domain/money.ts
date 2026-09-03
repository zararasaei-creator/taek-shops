/**
 * Money handling for Taek Shops.
 *
 * Every monetary amount in the database and domain layer is an integer number of
 * cents (see `docs/architecture.md`). This module is the single place that
 * parses, does arithmetic on, and formats that representation, so that no other
 * code is tempted to do money math with floating-point dollars.
 */

export type CurrencyCode = "CAD";

export const DEFAULT_CURRENCY: CurrencyCode = "CAD";

/** Thrown when a value that must be integer cents is not, or a string won't parse. */
export class MoneyError extends Error {}

/** Assert that a value is a safe integer count of cents. */
export function assertCents(value: number): number {
  if (!Number.isInteger(value)) {
    throw new MoneyError(`Monetary amounts must be integer cents; received ${value}.`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`Monetary amount ${value} exceeds the safe integer range.`);
  }
  return value;
}

/**
 * Parse a decimal money string (e.g. from a spreadsheet cell or admin form) to
 * integer cents, exactly — without ever constructing a floating-point dollar
 * value. Accepts an optional leading `-`, `$`, thousands separators, and 0–2
 * decimal places.
 *
 * `parseAmountToCents("29.99") === 2999`
 * `parseAmountToCents("$1,000") === 100000`
 */
export function parseAmountToCents(input: string): number {
  const cleaned = input.trim().replace(/^\$/, "").replace(/,/g, "");
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) {
    throw new MoneyError(`Cannot parse "${input}" as a money amount.`);
  }
  const [, sign, whole, fraction = ""] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return assertCents(sign ? -cents : cents);
}

/** Convert integer cents to a decimal number, for display/formatting only. */
export function toDecimal(cents: number): number {
  return assertCents(cents) / 100;
}

/** Add integer-cent amounts. */
export function addCents(...amounts: number[]): number {
  return assertCents(amounts.reduce((total, amount) => total + assertCents(amount), 0));
}

/** Multiply an integer-cent amount by an integer quantity. */
export function multiplyCents(cents: number, quantity: number): number {
  if (!Number.isInteger(quantity)) {
    throw new MoneyError(`Quantity must be an integer; received ${quantity}.`);
  }
  return assertCents(assertCents(cents) * quantity);
}

/**
 * Apply an exact fractional rate (e.g. a tax rate of 0.13) to an integer-cent
 * base, returning integer cents rounded half away from zero.
 *
 * `applyRate(10000, 0.13) === 1300`
 */
export function applyRate(cents: number, rate: number): number {
  if (!Number.isFinite(rate) || rate < 0) {
    throw new MoneyError(`Rate must be a finite, non-negative number; received ${rate}.`);
  }
  const scaled = assertCents(cents) * rate;
  return Math.sign(scaled) * Math.round(Math.abs(scaled));
}

/** Format integer cents for display, e.g. `formatCents(2999) === "$29.99"`. */
export function formatCents(
  cents: number,
  currency: CurrencyCode = DEFAULT_CURRENCY,
  locale = "en-CA",
): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(toDecimal(cents));
}
