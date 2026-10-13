import { afterAll, describe, expect, it } from "vitest";

import { extendProductOption } from "@/server/catalog/option-service";
import { createVariant, generateVariantMatrix } from "@/server/catalog/variant-service";
import { ConflictError, ReferentialIntegrityError } from "@/server/catalog/errors";
import { db, ensureActor } from "./helpers/db";

/**
 * Catalog/variant pre-work (extend-options backfill + admin variant matrix
 * generator) against a real PostgreSQL instance.
 *
 * Namespacing for exact cleanup:
 *   - products : slug starts `zzz-catmx-`
 *   - variants : sku   starts `CATMX-`
 */
const SLUG_PREFIX = "zzz-catmx-";
const SKU_PREFIX = "CATMX-";

let n = 0;
function uid(): string {
  n += 1;
  return `${Date.now().toString(36)}${n}`;
}

async function makeProduct(): Promise<{ id: string; slug: string }> {
  const suffix = uid();
  return db.product.create({
    data: {
      name: `Matrix Test ${suffix}`,
      slug: `${SLUG_PREFIX}${suffix}`,
      status: "ACTIVE",
      active: true,
    },
    select: { id: true, slug: true },
  });
}

async function addOption(
  productId: string,
  name: string,
  values: string[],
): Promise<{ id: string; values: { id: string; value: string }[] }> {
  return db.productOption.create({
    data: {
      productId,
      name,
      position: 0,
      values: { create: values.map((value, index) => ({ value, position: index })) },
    },
    select: { id: true, values: { orderBy: { position: "asc" } } },
  });
}

/** A variant already distinguished by a pre-existing "Size" option value. */
async function makeSizedVariant(
  productId: string,
  sku: string,
  sizeOptionId: string,
  sizeValueId: string,
): Promise<{ id: string }> {
  return db.productVariant.create({
    data: {
      productId,
      sku,
      priceCents: 1000,
      optionSignature: sizeValueId,
      optionValues: {
        create: [
          {
            option: { connect: { id: sizeOptionId } },
            optionValue: { connect: { id: sizeValueId } },
          },
        ],
      },
      inventoryItem: { create: { quantityOnHand: 0, quantityReserved: 0 } },
    },
    select: { id: true },
  });
}

afterAll(async () => {
  await db.product.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
  await db.$disconnect();
});

describe("extendProductOption (real DB)", () => {
  it("adds an option with no backfill needed when the product has no variants", async () => {
    const actor = await ensureActor();
    const product = await makeProduct();

    const option = await extendProductOption(actor, product.id, {
      name: "Size",
      values: ["S", "M", "L"],
      position: 0,
      backfill: [],
    });

    expect(option.values.map((v) => v.value)).toEqual(["S", "M", "L"]);
    const stored = await db.productOption.findUnique({ where: { id: option.id } });
    expect(stored?.name).toBe("Size");
  });

  it("backfills every existing variant atomically and preserves optionSignature uniqueness", async () => {
    const actor = await ensureActor();
    const product = await makeProduct();
    const size = await addOption(product.id, "Size", ["S", "M"]);
    const sizeS = size.values.find((v) => v.value === "S")!;
    const sizeM = size.values.find((v) => v.value === "M")!;
    const v1 = await makeSizedVariant(product.id, `${SKU_PREFIX}${uid()}`, size.id, sizeS.id);
    const v2 = await makeSizedVariant(product.id, `${SKU_PREFIX}${uid()}`, size.id, sizeM.id);

    const option = await extendProductOption(actor, product.id, {
      name: "Colour",
      values: ["White", "Black"],
      position: 0,
      backfill: [
        { variantId: v1.id, value: "White" },
        { variantId: v2.id, value: "Black" },
      ],
    });

    const [stored1, stored2] = await Promise.all([
      db.productVariant.findUniqueOrThrow({ where: { id: v1.id } }),
      db.productVariant.findUniqueOrThrow({ where: { id: v2.id } }),
    ]);
    const whiteId = option.values.find((v) => v.value === "White")!.id;
    const blackId = option.values.find((v) => v.value === "Black")!.id;
    expect(stored1.optionSignature).toBe([sizeS.id, whiteId].sort().join("|"));
    expect(stored2.optionSignature).toBe([sizeM.id, blackId].sort().join("|"));
    expect(stored1.optionSignature).not.toBe(stored2.optionSignature);

    const joins = await db.productVariantOptionValue.findMany({
      where: { variantId: { in: [v1.id, v2.id] } },
    });
    expect(joins).toHaveLength(4); // 2 variants x (Size + Colour)
  });

  it("rolls back the entire operation when a variant is missing a backfill value", async () => {
    const actor = await ensureActor();
    const product = await makeProduct();
    const size = await addOption(product.id, "Size", ["S", "M"]);
    const sizeS = size.values.find((v) => v.value === "S")!;
    const sizeM = size.values.find((v) => v.value === "M")!;
    const v1 = await makeSizedVariant(product.id, `${SKU_PREFIX}${uid()}`, size.id, sizeS.id);
    await makeSizedVariant(product.id, `${SKU_PREFIX}${uid()}`, size.id, sizeM.id); // v2, not backfilled

    await expect(
      extendProductOption(actor, product.id, {
        name: "Colour",
        values: ["White"],
        position: 0,
        backfill: [{ variantId: v1.id, value: "White" }],
      }),
    ).rejects.toThrow();

    const options = await db.productOption.findMany({ where: { productId: product.id } });
    expect(options.map((o) => o.name)).toEqual(["Size"]); // Colour never committed
    const variant1 = await db.productVariant.findUniqueOrThrow({ where: { id: v1.id } });
    expect(variant1.optionSignature).toBe(sizeS.id); // unchanged
  });

  it("rejects an option name that already exists on the product", async () => {
    const actor = await ensureActor();
    const product = await makeProduct();
    await addOption(product.id, "Size", ["S", "M"]);

    await expect(
      extendProductOption(actor, product.id, {
        name: "Size",
        values: ["L"],
        position: 0,
        backfill: [],
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("resolveSelections gating (real DB, via createVariant)", () => {
  it("refuses to implicitly create a brand-new option when the product already has other variants", async () => {
    const actor = await ensureActor();
    const product = await makeProduct();
    await addOption(product.id, "Size", ["S", "M"]);

    await createVariant(actor, product.id, {
      sku: `${SKU_PREFIX}${uid()}`,
      priceCents: 1000,
      position: 0,
      active: true,
      trackInventory: true,
      initialQuantity: 0,
      optionSelections: [{ option: "Size", value: "S" }],
    });

    await expect(
      createVariant(actor, product.id, {
        sku: `${SKU_PREFIX}${uid()}`,
        priceCents: 1000,
        position: 0,
        active: true,
        trackInventory: true,
        initialQuantity: 0,
        optionSelections: [
          { option: "Size", value: "M" },
          { option: "Colour", value: "Red" }, // brand-new option — should be refused
        ],
      }),
    ).rejects.toBeInstanceOf(ReferentialIntegrityError);

    // No stray "Colour" option was left behind by the rejected attempt.
    const options = await db.productOption.findMany({ where: { productId: product.id } });
    expect(options.map((o) => o.name)).toEqual(["Size"]);
  });
});

describe("generateVariantMatrix (real DB)", () => {
  it("bulk-creates the full Cartesian product atomically with independent inventory", async () => {
    const actor = await ensureActor();
    const product = await makeProduct();
    await addOption(product.id, "Size", ["S", "M"]);
    await addOption(product.id, "Colour", ["White", "Black"]);

    const skus = {
      sw: `${SKU_PREFIX}${uid()}`,
      mw: `${SKU_PREFIX}${uid()}`,
      sb: `${SKU_PREFIX}${uid()}`,
      mb: `${SKU_PREFIX}${uid()}`,
    };
    const cell = (sku: string, size: string, colour: string, qty: number) => ({
      sku,
      priceCents: 2500,
      position: 0,
      active: true,
      trackInventory: true,
      initialQuantity: qty,
      optionSelections: [
        { option: "Size", value: size },
        { option: "Colour", value: colour },
      ],
    });

    const variants = await generateVariantMatrix(actor, product.id, {
      cells: [
        cell(skus.sw, "S", "White", 5),
        cell(skus.mw, "M", "White", 7),
        cell(skus.sb, "S", "Black", 3),
        cell(skus.mb, "M", "Black", 9),
      ],
    });

    expect(variants).toHaveLength(4);
    const inventory = await db.inventoryItem.findMany({
      where: { variantId: { in: variants.map((v) => v.id) } },
      select: { variantId: true, quantityOnHand: true },
    });
    const bySku = new Map(variants.map((v) => [v.id, v.sku]));
    const qtyBySku = new Map(inventory.map((i) => [bySku.get(i.variantId), i.quantityOnHand]));
    expect(qtyBySku.get(skus.sw)).toBe(5);
    expect(qtyBySku.get(skus.mw)).toBe(7);
    expect(qtyBySku.get(skus.sb)).toBe(3);
    expect(qtyBySku.get(skus.mb)).toBe(9);

    const signatures = new Set(
      (
        await db.productVariant.findMany({
          where: { productId: product.id },
          select: { optionSignature: true },
        })
      ).map((v) => v.optionSignature),
    );
    expect(signatures.size).toBe(4); // all distinct
  });

  it("rejects duplicate SKUs within the batch and creates nothing", async () => {
    const actor = await ensureActor();
    const product = await makeProduct();
    await addOption(product.id, "Size", ["S", "M"]);
    const dupeSku = `${SKU_PREFIX}${uid()}`;

    await expect(
      generateVariantMatrix(actor, product.id, {
        cells: [
          {
            sku: dupeSku,
            priceCents: 1000,
            position: 0,
            active: true,
            trackInventory: true,
            initialQuantity: 0,
            optionSelections: [{ option: "Size", value: "S" }],
          },
          {
            sku: dupeSku,
            priceCents: 1000,
            position: 0,
            active: true,
            trackInventory: true,
            initialQuantity: 0,
            optionSelections: [{ option: "Size", value: "M" }],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    const count = await db.productVariant.count({ where: { productId: product.id } });
    expect(count).toBe(0);
  });

  it("rolls back the whole batch when one cell collides with an existing variant", async () => {
    const actor = await ensureActor();
    const product = await makeProduct();
    await addOption(product.id, "Size", ["S", "M"]);
    const existingSku = `${SKU_PREFIX}${uid()}`;
    await createVariant(actor, product.id, {
      sku: existingSku,
      priceCents: 1000,
      position: 0,
      active: true,
      trackInventory: true,
      initialQuantity: 0,
      optionSelections: [{ option: "Size", value: "S" }],
    });

    const newSku = `${SKU_PREFIX}${uid()}`;
    await expect(
      generateVariantMatrix(actor, product.id, {
        cells: [
          {
            sku: newSku,
            priceCents: 1000,
            position: 0,
            active: true,
            trackInventory: true,
            initialQuantity: 0,
            optionSelections: [{ option: "Size", value: "M" }],
          },
          {
            // Same combination (Size: S) as the pre-existing variant.
            sku: `${SKU_PREFIX}${uid()}`,
            priceCents: 1000,
            position: 0,
            active: true,
            trackInventory: true,
            initialQuantity: 0,
            optionSelections: [{ option: "Size", value: "S" }],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    // The batch is atomic: the valid first cell must NOT have been committed either.
    const stray = await db.productVariant.findUnique({ where: { sku: newSku } });
    expect(stray).toBeNull();
  });

  it("rejects a cell missing a value for one of the product's options", async () => {
    const actor = await ensureActor();
    const product = await makeProduct();
    await addOption(product.id, "Size", ["S", "M"]);
    await addOption(product.id, "Colour", ["White"]);

    await expect(
      generateVariantMatrix(actor, product.id, {
        cells: [
          {
            sku: `${SKU_PREFIX}${uid()}`,
            priceCents: 1000,
            position: 0,
            active: true,
            trackInventory: true,
            initialQuantity: 0,
            optionSelections: [{ option: "Size", value: "S" }], // missing Colour
          },
        ],
      }),
    ).rejects.toThrow();
  });
});
