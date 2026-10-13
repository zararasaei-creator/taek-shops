/**
 * Pure, framework-free helpers for the admin Variant Matrix Generator. No
 * Prisma/DB access here — safe to import from both server code and a "use
 * client" component so the browser can compute the same Cartesian product the
 * server will later validate.
 */

export interface MatrixOptionGroup {
  optionId: string;
  optionName: string;
  values: { id: string; value: string }[];
}

export interface MatrixCombo {
  /** One selection per group, in the same order as the input groups. */
  selections: { optionId: string; optionName: string; valueId: string; value: string }[];
}

/**
 * Cartesian product of the selected values across every option group. A group
 * with zero selected values yields zero combinations (nothing to multiply by).
 */
export function computeCartesianProduct(groups: MatrixOptionGroup[]): MatrixCombo[] {
  if (groups.length === 0) return [];
  if (groups.some((g) => g.values.length === 0)) return [];

  let combos: MatrixCombo["selections"][] = [[]];
  for (const group of groups) {
    const next: MatrixCombo["selections"][] = [];
    for (const partial of combos) {
      for (const value of group.values) {
        next.push([
          ...partial,
          {
            optionId: group.optionId,
            optionName: group.optionName,
            valueId: value.id,
            value: value.value,
          },
        ]);
      }
    }
    combos = next;
  }
  return combos.map((selections) => ({ selections }));
}

/** Canonical, order-independent key for a combo — used to detect duplicate combinations. */
export function comboKey(selections: { optionName: string; value: string }[]): string {
  return [...selections]
    .map((s) => `${s.optionName.trim().toLowerCase()}=${s.value.trim().toLowerCase()}`)
    .sort()
    .join("|");
}

/** Turn free text into a SKU-safe fragment: letters/digits/'-' only, upper-cased. */
export function slugifySkuPart(text: string): string {
  return text
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Suggest a SKU for a combo from a base (e.g. the product slug) + its selected values. */
export function suggestSku(base: string, selections: { value: string }[]): string {
  const parts = [slugifySkuPart(base), ...selections.map((s) => slugifySkuPart(s.value))].filter(
    Boolean,
  );
  return parts.join("-").slice(0, 64);
}
