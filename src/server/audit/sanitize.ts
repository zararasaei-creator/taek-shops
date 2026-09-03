/**
 * Metadata sanitisation for audit records.
 *
 * Audit metadata is developer-supplied but must never carry secrets. This
 * redacts any key that looks sensitive, drops functions/symbols, caps depth and
 * breadth, and guarantees the result is plain JSON.
 */

const SENSITIVE_KEY =
  /pass(word|phrase)?|secret|token|hash|salt|credential|authorization|cookie|otp|pin|cvv|card(number)?|ssn|apikey|api_key|private[_-]?key/i;

const REDACTED = "[redacted]";
const MAX_DEPTH = 6;
const MAX_ARRAY = 100;
const MAX_KEYS = 100;
const MAX_STRING = 2_000;

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function sanitizeAuditMetadata(input: unknown): Record<string, JsonValue> | undefined {
  if (input == null) return undefined;
  const walked = walk(input, 0);
  if (walked && typeof walked === "object" && !Array.isArray(walked)) {
    return walked;
  }
  // Non-object metadata is wrapped so the column shape stays predictable.
  return { value: walked };
}

function walk(value: unknown, depth: number): JsonValue {
  if (depth > MAX_DEPTH) return REDACTED;

  if (value === null) return null;

  switch (typeof value) {
    case "string":
      return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "undefined":
    case "function":
    case "symbol":
      return null;
    default:
      break;
  }

  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((item) => walk(item, depth + 1));
  }

  const result: Record<string, JsonValue> = {};
  const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS);
  for (const [key, item] of entries) {
    result[key] = SENSITIVE_KEY.test(key) ? REDACTED : walk(item, depth + 1);
  }
  return result;
}
