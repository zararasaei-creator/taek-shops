// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseCsv, normalizeHeader } from "@/server/import/csv-parser";
import {
  CANONICAL_IMPORT_COLUMNS,
  IMPORT_COLUMN_ALIASES,
  KNOWN_IMPORT_COLUMNS,
  buildProductImportTemplate,
} from "@/server/import/product-import-columns";
import { parseProductRow } from "@/server/import/product-import-schema";

const enc = (text: string) => new TextEncoder().encode(text);

/**
 * The downloadable template and the parser must never drift apart: a header the
 * template emits that the parser doesn't recognise would be "silently ignored"
 * (the inventory_on_hand bug). These tests fail if that can happen again.
 */
describe("product import template <-> parser contract", () => {
  const template = buildProductImportTemplate();
  const table = parseCsv(enc(template), "hash");

  it("every header the template emits is recognised by the parser", () => {
    for (const header of table.columns) {
      expect(KNOWN_IMPORT_COLUMNS).toContain(header);
    }
  });

  it("the template header is exactly the canonical column list, in order", () => {
    expect(table.columns).toEqual(CANONICAL_IMPORT_COLUMNS.map(normalizeHeader));
  });

  it("the template's own example rows parse with zero errors", () => {
    for (const row of table.rows) {
      const { data, errors } = parseProductRow(row.values);
      expect(errors).toEqual([]);
      expect(data).toBeDefined();
    }
  });

  it("the inventory column in the template actually feeds inventoryOnHand", () => {
    // Row values as they appear in the template: 25, 18, 45.
    const parsed = table.rows.map((r) => parseProductRow(r.values).data?.inventoryOnHand);
    expect(parsed).toEqual([25, 18, 45]);
  });

  it("every alias resolves to a real canonical column and never shadows one", () => {
    for (const [alias, canonical] of Object.entries(IMPORT_COLUMN_ALIASES)) {
      expect(CANONICAL_IMPORT_COLUMNS).toContain(canonical);
      expect(CANONICAL_IMPORT_COLUMNS).not.toContain(alias);
    }
  });

  it("the checked-in docs template file matches the generated template byte-for-byte", () => {
    const onDisk = readFileSync(join(process.cwd(), "docs/product-import-template.csv"), "utf8");
    expect(onDisk.replace(/\r\n/g, "\n")).toBe(template.replace(/\r\n/g, "\n"));
  });
});
