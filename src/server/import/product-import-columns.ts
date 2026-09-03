import { toCsv } from "@/server/import/cell-sanitize";

/**
 * The Phase 4 product-import CSV contract.
 *
 * One row = one product variant (one SKU). Product-level fields are repeated on
 * every variant row of the same product and must be consistent.
 *
 * Update identifiers:
 * - **variant**: `sku` (unique, case-insensitive, stored as given) — the upsert key;
 * - **product**: `product_slug` if provided, otherwise a slug derived from
 *   `product_name`. Stable across imports.
 *
 * Options are NOT limited to Size/Colour: up to three `optionN_name` /
 * `optionN_value` pairs, each mapped onto the normalised
 * ProductOption/ProductOptionValue model.
 */

export interface ImportColumn {
  key: string;
  required: boolean;
  description: string;
  example: string;
}

export const PRODUCT_IMPORT_COLUMNS: ImportColumn[] = [
  {
    key: "sku",
    required: true,
    description: "Unique variant SKU. The update key.",
    example: "UNI-STU-WHT-140",
  },
  {
    key: "product_name",
    required: true,
    description: "Product display name.",
    example: "Student Taekwondo Uniform",
  },
  {
    key: "product_slug",
    required: false,
    description: "Stable product URL key. Derived from product_name if blank.",
    example: "student-taekwondo-uniform",
  },
  {
    key: "description",
    required: false,
    description: "Product description (plain text).",
    example: "Lightweight poly-cotton dobok.",
  },
  {
    key: "brand",
    required: false,
    description: "Brand name. Created if it does not exist.",
    example: "Taek Basics",
  },
  {
    key: "category",
    required: false,
    description: "Category name. Created if it does not exist.",
    example: "Uniforms",
  },
  {
    key: "status",
    required: false,
    description: "draft | active | archived. Default: draft.",
    example: "active",
  },
  {
    key: "price",
    required: true,
    description: "Selling price in CAD dollars (e.g. 39.99). Stored as integer cents.",
    example: "39.99",
  },
  {
    key: "compare_at_price",
    required: false,
    description: "Was-price in CAD dollars. Must exceed price.",
    example: "49.99",
  },
  {
    key: "cost_price",
    required: false,
    description: "Internal cost in CAD dollars.",
    example: "18.50",
  },
  {
    key: "barcode",
    required: false,
    description: "EAN/UPC or internal barcode. Unique.",
    example: "06251234567890",
  },
  {
    key: "weight_grams",
    required: false,
    description: "Variant weight in grams (integer).",
    example: "600",
  },
  {
    key: "inventory_quantity",
    required: false,
    description: "On-hand quantity to set (integer >= 0). Default: leave unchanged / 0 on create.",
    example: "120",
  },
  {
    key: "option1_name",
    required: false,
    description: "First option name (e.g. Size).",
    example: "Size",
  },
  {
    key: "option1_value",
    required: false,
    description: "First option value (e.g. 140).",
    example: "140",
  },
  { key: "option2_name", required: false, description: "Second option name.", example: "Colour" },
  { key: "option2_value", required: false, description: "Second option value.", example: "White" },
  { key: "option3_name", required: false, description: "Third option name.", example: "" },
  { key: "option3_value", required: false, description: "Third option value.", example: "" },
  {
    key: "image_url",
    required: false,
    description: "Absolute https URL of a product image.",
    example: "https://cdn.example.com/uni-white.jpg",
  },
];

export const REQUIRED_IMPORT_COLUMNS = PRODUCT_IMPORT_COLUMNS.filter((c) => c.required).map(
  (c) => c.key,
);
export const KNOWN_IMPORT_COLUMNS = PRODUCT_IMPORT_COLUMNS.map((c) => c.key);

/** Canonical CSV template with three synthetic example rows (no real data). */
export function buildProductImportTemplate(): string {
  const header = KNOWN_IMPORT_COLUMNS;
  const rows: (string | number)[][] = [
    [
      "UNI-STU-WHT-140",
      "Student Taekwondo Uniform",
      "student-taekwondo-uniform",
      "Lightweight poly-cotton dobok for beginners.",
      "Taek Basics",
      "Uniforms",
      "active",
      "39.99",
      "49.99",
      "18.50",
      "",
      "600",
      "25",
      "Size",
      "140",
      "Colour",
      "White",
      "",
      "",
      "https://cdn.example.com/img/uni-stu-wht.jpg",
    ],
    [
      "UNI-STU-WHT-160",
      "Student Taekwondo Uniform",
      "student-taekwondo-uniform",
      "Lightweight poly-cotton dobok for beginners.",
      "Taek Basics",
      "Uniforms",
      "active",
      "42.99",
      "",
      "19.50",
      "",
      "680",
      "18",
      "Size",
      "160",
      "Colour",
      "White",
      "",
      "",
      "https://cdn.example.com/img/uni-stu-wht.jpg",
    ],
    [
      "BLT-COMP-BLK-4",
      "Competition Black Belt",
      "competition-black-belt",
      "Cotton competition belt with silk stitching.",
      "Taek Basics",
      "Belts",
      "draft",
      "17.99",
      "",
      "7.00",
      "",
      "180",
      "45",
      "Size",
      "4",
      "",
      "",
      "",
      "",
      "",
    ],
  ];
  return toCsv(header as string[], rows);
}
