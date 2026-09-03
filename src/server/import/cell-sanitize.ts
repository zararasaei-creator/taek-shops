/**
 * CSV / spreadsheet injection defence.
 *
 * A cell whose value begins with `= + - @` or a control character can be
 * interpreted as a formula by Excel / Sheets / LibreOffice. We:
 * - never evaluate formulas (cells are only ever read as text);
 * - `neutralizeForImport` strips control characters and any leading formula
 *   trigger from values read out of an uploaded file;
 * - `escapeForCsvOutput` / `toCsv` prefix a leading `'` when writing values back
 *   out (templates, error reports).
 */

// All C0 control characters except TAB (\x09), LF (\x0A), CR (\x0D).
const CONTROL_CHARS = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]", "g");
const LEADING_TRIGGER = new RegExp("^[=+\\-@\\t\\r]");

export function looksLikeFormula(value: string): boolean {
  return LEADING_TRIGGER.test(value);
}

/**
 * For values read from an uploaded file: strip control characters and repeatedly
 * remove a leading formula trigger so the value is safe to store and display.
 */
export function neutralizeForImport(value: string): { value: string; wasNeutralized: boolean } {
  let cleaned = value.replace(CONTROL_CHARS, "");
  let wasNeutralized = cleaned !== value;

  let previous: string;
  do {
    previous = cleaned;
    const trimmed = cleaned.replace(/^\s+/, "");
    if (LEADING_TRIGGER.test(trimmed)) {
      cleaned = trimmed.slice(1);
      wasNeutralized = true;
    }
  } while (cleaned !== previous);

  return { value: cleaned.trim(), wasNeutralized };
}

/** For values written into a CSV we produce (template rows, error reports). */
export function escapeForCsvOutput(value: string): string {
  return looksLikeFormula(value) ? `'${value}` : value;
}

/** Quote a single CSV field (RFC 4180) after formula-escaping it. */
export function csvField(value: string | number | boolean | null | undefined): string {
  const raw = value == null ? "" : String(value);
  const safe = escapeForCsvOutput(raw);
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Build a CSV document from a header + rows. */
export function toCsv(
  header: string[],
  rows: (string | number | boolean | null | undefined)[][],
): string {
  const lines = [header.map(csvField).join(","), ...rows.map((row) => row.map(csvField).join(","))];
  return lines.join("\r\n") + "\r\n";
}
