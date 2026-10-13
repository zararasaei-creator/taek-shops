import { afterAll, afterEach, describe, expect, it } from "vitest";

import { commitImport, previewImport } from "@/server/import/product-import-service";
import { buildProductImportTemplate } from "@/server/import/product-import-columns";
import { db, ensureActor } from "./helpers/db";

/**
 * Product CSV import against a real PostgreSQL instance: row -> Product/Variant
 * mapping, variant + product image association, update-by-SKU without
 * clobbering untouched fields, and duplicate-SKU detection.
 *
 * Fixtures: products slug starts `zzz-imp-`, variants sku starts `IMP-`,
 * import jobs filename starts `zzz-imp-`.
 */
const SLUG = "zzz-imp-dobok";
const FILE = "zzz-imp-test.csv";

const HEADER =
  "sku,product_name,product_slug,description,price,compare_at_price,inventory_quantity," +
  "option1_name,option1_value,option2_name,option2_value,image_url,variant_image_url";

const enc = (rows: string[]) => new TextEncoder().encode([HEADER, ...rows].join("\n") + "\n");

async function runImport(actor: Awaited<ReturnType<typeof ensureActor>>, rows: string[]) {
  const preview = await previewImport(actor, { filename: FILE, bytes: enc(rows) }, db);
  const commit = await commitImport(actor, preview.importJobId, {}, db);
  return { preview, commit };
}

afterEach(async () => {
  await db.productImage.deleteMany({ where: { product: { slug: { startsWith: "zzz-imp-" } } } });
  await db.product.deleteMany({ where: { slug: { startsWith: "zzz-imp-" } } });
  await db.importJob.deleteMany({ where: { originalFilename: { startsWith: "zzz-imp-" } } });
});

afterAll(async () => {
  await db.$disconnect();
});

describe("product CSV import (real DB)", () => {
  it("maps rows into one product with two variants and associates images correctly", async () => {
    const actor = await ensureActor();
    const { preview, commit } = await runImport(actor, [
      `IMP-140,Student Dobok,${SLUG},A light dobok,39.99,,10,Size,140,Colour,White,https://cdn.example.com/dobok.jpg,https://cdn.example.com/dobok-140.jpg`,
      `IMP-160,Student Dobok,${SLUG},A light dobok,42.99,,8,Size,160,Colour,White,https://cdn.example.com/dobok.jpg,https://cdn.example.com/dobok-160.jpg`,
    ]);

    expect(preview.counts).toMatchObject({ create: 2, error: 0 });
    expect(commit.counts).toMatchObject({ created: 2, failed: 0 });

    const product = await db.product.findUniqueOrThrow({
      where: { slug: SLUG },
      include: {
        variants: { include: { optionValues: { include: { option: true, optionValue: true } } } },
        images: true,
      },
    });
    expect(product.variants).toHaveLength(2);
    // Each variant carries exactly Size + Colour.
    for (const variant of product.variants) {
      expect(variant.optionValues.map((ov) => ov.option.name).sort()).toEqual(["Colour", "Size"]);
    }
    // One deduped product-level image + one image per variant.
    const productImages = product.images.filter((i) => i.variantId === null);
    const variantImages = product.images.filter((i) => i.variantId !== null);
    expect(productImages).toHaveLength(1);
    expect(productImages[0]!.isPrimary).toBe(true);
    expect(variantImages).toHaveLength(2);
    expect(variantImages.every((i) => i.isPrimary === false)).toBe(true);
    expect(new Set(variantImages.map((i) => i.variantId))).toEqual(
      new Set(product.variants.map((v) => v.id)),
    );
  });

  it("updates an existing variant by SKU without clobbering fields the new row leaves blank", async () => {
    const actor = await ensureActor();
    await runImport(actor, [
      `IMP-140,Student Dobok,${SLUG},Original description,39.99,49.99,10,Size,140,,,,`,
    ]);

    // Re-import the same SKU: only the price is provided; description + compare-at are blank.
    const { commit } = await runImport(actor, [
      `IMP-140,Student Dobok,${SLUG},,45.00,,,Size,140,,,,`,
    ]);
    expect(commit.counts).toMatchObject({ updated: 1, created: 0, failed: 0 });

    const variant = await db.productVariant.findUniqueOrThrow({
      where: { sku: "IMP-140" },
      include: { product: true },
    });
    expect(variant.priceCents).toBe(4500); // changed
    expect(variant.compareAtPriceCents).toBe(4999); // preserved
    expect(variant.product.description).toBe("Original description"); // preserved
  });

  it("flags a duplicate SKU within the file at preview and never writes it", async () => {
    const actor = await ensureActor();
    const preview = await previewImport(
      actor,
      {
        filename: FILE,
        bytes: enc([
          `IMP-140,Student Dobok,${SLUG},x,39.99,,,Size,140,,,,`,
          `IMP-140,Student Dobok,${SLUG},x,41.99,,,Size,150,,,,`,
        ]),
      },
      db,
    );
    expect(preview.rows[1]!.errors.map((e) => e.code)).toContain("duplicate_sku_in_file");
    expect(preview.counts.error).toBe(1);
  });

  it("warns at preview when a row's option value is new to an existing product's option", async () => {
    const actor = await ensureActor();
    await runImport(actor, [`IMP-EU-40,Adult Shoe,${SLUG}-shoe,x,59.99,,,EU Size,40,,,,`]);

    const preview = await previewImport(
      actor,
      {
        filename: FILE,
        bytes: enc([`IMP-EU-41,Adult Shoe,${SLUG}-shoe,x,59.99,,,EU Size,41,,,,`]),
      },
      db,
    );
    expect(preview.rows[0]!.action).toBe("create");
    expect(preview.rows[0]!.warnings.join(" ")).toMatch(/new value for the existing option/i);
  });

  it("recognises inventory_on_hand from the official template header and stores it per variant", async () => {
    const actor = await ensureActor();

    // Use the exact header the downloadable template emits.
    const templateHeader = buildProductImportTemplate().split(/\r?\n/)[0]!;
    const columns = templateHeader.split(",");
    const rowFor = (fields: Record<string, string>) =>
      columns.map((c) => fields[c] ?? "").join(",");

    const csv = [
      templateHeader,
      rowFor({
        sku: "IMP-SHOE-40",
        product_name: "QA Shoe",
        product_slug: "zzz-imp-shoe",
        price: "59.99",
        inventory_on_hand: "5",
        option1_name: "EU Size",
        option1_value: "40",
      }),
      rowFor({
        sku: "IMP-SHOE-41",
        product_name: "QA Shoe",
        product_slug: "zzz-imp-shoe",
        price: "59.99",
        inventory_on_hand: "7",
        option1_name: "EU Size",
        option1_value: "41",
      }),
    ].join("\n");

    const preview = await previewImport(
      actor,
      { filename: FILE, bytes: new TextEncoder().encode(csv + "\n") },
      db,
    );
    // The template header must not produce "unknown column" noise.
    expect(preview.unknownColumns).toEqual([]);
    expect(preview.fileWarnings).toEqual([]);
    expect(preview.counts).toMatchObject({ create: 2, update: 0, error: 0 });

    const commit = await commitImport(actor, preview.importJobId, {}, db);
    expect(commit.counts).toMatchObject({ created: 2, failed: 0 });

    const rows = await db.productVariant.findMany({
      where: { sku: { in: ["IMP-SHOE-40", "IMP-SHOE-41"] } },
      select: { sku: true, inventoryItem: { select: { quantityOnHand: true } } },
    });
    const onHandBySku = Object.fromEntries(
      rows.map((r) => [r.sku, r.inventoryItem?.quantityOnHand]),
    );
    expect(onHandBySku).toEqual({ "IMP-SHOE-40": 5, "IMP-SHOE-41": 7 });
  });
});
