import { afterAll, describe, expect, it } from "vitest";

import { addProductOption, extendProductOption } from "@/server/catalog/option-service";
import { createVariant, generateVariantMatrix } from "@/server/catalog/variant-service";
import { db, ensureActor } from "./helpers/db";

/**
 * Proves the catalog option model is not apparel-bound: different products use
 * different size *systems* (EU / US / UK), different ranges, extra non-size
 * attributes, or no options at all — with no schema change and no hard-coded
 * size list anywhere.
 *
 * Fixtures: products slug starts `zzz-shoe-`, variants sku starts `SHOE-`.
 */
const SLUG_PREFIX = "zzz-shoe-";
const SKU_PREFIX = "SHOE-";

let n = 0;
const uid = () => `${Date.now().toString(36)}${(n += 1)}`;

async function makeProduct(name: string): Promise<{ id: string; slug: string }> {
  return db.product.create({
    data: { name, slug: `${SLUG_PREFIX}${uid()}`, status: "ACTIVE", active: true },
    select: { id: true, slug: true },
  });
}

const variantCell = (sku: string, selections: { option: string; value: string }[], qty = 0) => ({
  sku,
  priceCents: 5999,
  position: 0,
  active: true,
  trackInventory: true,
  initialQuantity: qty,
  optionSelections: selections,
});

afterAll(async () => {
  await db.product.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
  await db.$disconnect();
});

describe("shoe sizing flexibility (real DB)", () => {
  it("a toddler shoe exposes only its own EU size range", async () => {
    const actor = await ensureActor();
    const product = await makeProduct("Toddler Taekwondo Shoe");
    await addProductOption(actor, product.id, {
      name: "EU Size",
      values: ["22", "23", "24", "25"],
    });

    const variants = await generateVariantMatrix(actor, product.id, {
      cells: ["22", "23", "24", "25"].map((size) =>
        variantCell(`${SKU_PREFIX}T-${size}-${uid()}`, [{ option: "EU Size", value: size }], 3),
      ),
    });

    expect(variants).toHaveLength(4);
    const values = await db.productOptionValue.findMany({
      where: { option: { productId: product.id, name: "EU Size" } },
      select: { value: true },
    });
    expect(values.map((v) => v.value).sort()).toEqual(["22", "23", "24", "25"]);
    // Independent stock per generated variant.
    const items = await db.inventoryItem.findMany({
      where: { variantId: { in: variants.map((v) => v.id) } },
      select: { quantityOnHand: true },
    });
    expect(items.every((i) => i.quantityOnHand === 3)).toBe(true);
  });

  it("an adult men's shoe uses a different size system (US) plus a width attribute", async () => {
    const actor = await ensureActor();
    const product = await makeProduct("Adult Men Competition Shoe");
    await addProductOption(actor, product.id, { name: "US Size", values: ["8", "9", "10", "11"] });
    await addProductOption(actor, product.id, { name: "Width", values: ["D", "EE"] });

    const cells: ReturnType<typeof variantCell>[] = [];
    for (const size of ["8", "9", "10", "11"]) {
      for (const width of ["D", "EE"]) {
        cells.push(
          variantCell(`${SKU_PREFIX}M-${size}-${width}-${uid()}`, [
            { option: "US Size", value: size },
            { option: "Width", value: width },
          ]),
        );
      }
    }
    const variants = await generateVariantMatrix(actor, product.id, { cells });
    expect(variants).toHaveLength(8);

    const signatures = new Set(
      (
        await db.productVariant.findMany({
          where: { productId: product.id },
          select: { optionSignature: true },
        })
      ).map((v) => v.optionSignature),
    );
    expect(signatures.size).toBe(8); // every US-size x width combination is distinct
  });

  it("supports layering a second size system (UK) onto an existing EU-sized shoe", async () => {
    const actor = await ensureActor();
    const product = await makeProduct("Youth Shoe EU");
    await addProductOption(actor, product.id, { name: "EU Size", values: ["36", "37"] });
    const v36 = await createVariant(
      actor,
      product.id,
      variantCell(`${SKU_PREFIX}Y-36-${uid()}`, [{ option: "EU Size", value: "36" }]),
    );
    const v37 = await createVariant(
      actor,
      product.id,
      variantCell(`${SKU_PREFIX}Y-37-${uid()}`, [{ option: "EU Size", value: "37" }]),
    );

    await extendProductOption(actor, product.id, {
      name: "UK Size",
      values: ["3", "4"],
      position: 1,
      backfill: [
        { variantId: v36.id, value: "3" },
        { variantId: v37.id, value: "4" },
      ],
    });

    const joins = await db.productVariantOptionValue.findMany({
      where: { variantId: { in: [v36.id, v37.id] } },
    });
    expect(joins).toHaveLength(4); // each variant now carries EU Size + UK Size
  });

  it("an accessory with no options is a single variant with an empty signature", async () => {
    const actor = await ensureActor();
    const product = await makeProduct("Taekwondo Focus Mitt");
    const variant = await createVariant(
      actor,
      product.id,
      variantCell(`${SKU_PREFIX}ACC-${uid()}`, []),
    );
    expect(variant.optionSignature).toBe("");
    const count = await db.productVariant.count({ where: { productId: product.id } });
    expect(count).toBe(1);
  });

  it("supports a non-size, non-colour attribute (proves future extensibility)", async () => {
    const actor = await ensureActor();
    const product = await makeProduct("Training Weapon");
    await addProductOption(actor, product.id, { name: "Grip Type", values: ["Standard", "Pro"] });
    await addProductOption(actor, product.id, { name: "Length (cm)", values: ["70", "80", "90"] });

    const cells: ReturnType<typeof variantCell>[] = [];
    for (const grip of ["Standard", "Pro"]) {
      for (const length of ["70", "80", "90"]) {
        cells.push(
          variantCell(`${SKU_PREFIX}W-${grip[0]}-${length}-${uid()}`, [
            { option: "Grip Type", value: grip },
            { option: "Length (cm)", value: length },
          ]),
        );
      }
    }
    const variants = await generateVariantMatrix(actor, product.id, { cells });
    expect(variants).toHaveLength(6);
  });
});
