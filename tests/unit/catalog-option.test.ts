// @vitest-environment node
import { UserRole } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ForbiddenError, UnauthenticatedError } from "@/server/auth/errors";
import { CatalogValidationError, ConflictError, NotFoundError } from "@/server/catalog/errors";
import { extendProductOption } from "@/server/catalog/option-service";
import { createMockPrisma, looseMock, type MockPrisma } from "./helpers/mock-prisma";

const manager = { id: "mgr", role: UserRole.MANAGER };
const staff = { id: "stf", role: UserRole.STAFF };

interface ExistingVariant {
  id: string;
  optionValues: { optionValueId: string }[];
}

function wire(
  db: MockPrisma,
  opts: { existingVariants?: ExistingVariant[]; nameClash?: boolean; noProduct?: boolean } = {},
) {
  db.product.findUnique.mockResolvedValue(opts.noProduct ? null : ({ id: "prod_1" } as never));
  db.productOption.findUnique.mockResolvedValue(
    opts.nameClash ? ({ id: "opt_existing" } as never) : null,
  );
  db.productVariant.findMany.mockResolvedValue((opts.existingVariants ?? []) as never);

  looseMock(db.productOption.create).mockImplementation((args) => {
    const values = (args.data.values.create as { value: string; position: number }[]).map(
      (v, i) => ({ id: `val_${v.value}`, value: v.value, position: i }),
    );
    return Promise.resolve({ id: "opt_new", name: args.data.name, values } as never);
  });
  db.productVariantOptionValue.create.mockResolvedValue({} as never);
  db.productVariant.update.mockResolvedValue({} as never);
  db.auditLog.create.mockResolvedValue({} as never);
}

const baseInput = { name: "Colour", values: ["White", "Black"], position: 0, backfill: [] };

describe("extendProductOption", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
    vi.clearAllMocks();
  });

  it("requires the catalog.write permission", async () => {
    wire(db);
    await expect(extendProductOption(null, "prod_1", baseInput, {}, db)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    await expect(extendProductOption(staff, "prod_1", baseInput, {}, db)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("rejects duplicate values", async () => {
    wire(db);
    await expect(
      extendProductOption(manager, "prod_1", { ...baseInput, values: ["White", "White"] }, {}, db),
    ).rejects.toBeInstanceOf(CatalogValidationError);
  });

  it("rejects an unknown product", async () => {
    wire(db, { noProduct: true });
    await expect(extendProductOption(manager, "prod_1", baseInput, {}, db)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("rejects an option name that already exists on the product", async () => {
    wire(db, { nameClash: true });
    await expect(extendProductOption(manager, "prod_1", baseInput, {}, db)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("rejects backfill when the product has no variants yet", async () => {
    wire(db, { existingVariants: [] });
    await expect(
      extendProductOption(
        manager,
        "prod_1",
        { ...baseInput, backfill: [{ variantId: "v1", value: "White" }] },
        {},
        db,
      ),
    ).rejects.toBeInstanceOf(CatalogValidationError);
  });

  it("rejects a missing backfill entry for an existing variant", async () => {
    wire(db, {
      existingVariants: [
        { id: "v1", optionValues: [] },
        { id: "v2", optionValues: [] },
      ],
    });
    await expect(
      extendProductOption(
        manager,
        "prod_1",
        { ...baseInput, backfill: [{ variantId: "v1", value: "White" }] },
        {},
        db,
      ),
    ).rejects.toBeInstanceOf(CatalogValidationError);
  });

  it("rejects backfill referencing a variant from another product", async () => {
    wire(db, { existingVariants: [{ id: "v1", optionValues: [] }] });
    await expect(
      extendProductOption(
        manager,
        "prod_1",
        {
          ...baseInput,
          backfill: [
            { variantId: "v1", value: "White" },
            { variantId: "other-product-variant", value: "White" },
          ],
        },
        {},
        db,
      ),
    ).rejects.toBeInstanceOf(CatalogValidationError);
  });

  it("rejects a backfill value that isn't one of the new values", async () => {
    wire(db, { existingVariants: [{ id: "v1", optionValues: [] }] });
    await expect(
      extendProductOption(
        manager,
        "prod_1",
        { ...baseInput, backfill: [{ variantId: "v1", value: "Purple" }] },
        {},
        db,
      ),
    ).rejects.toBeInstanceOf(CatalogValidationError);
  });

  it("creates the option with no backfill needed when there are no variants", async () => {
    wire(db, { existingVariants: [] });
    const option = await extendProductOption(manager, "prod_1", baseInput, {}, db);
    expect(option.name).toBe("Colour");
    expect(db.productVariantOptionValue.create).not.toHaveBeenCalled();
    const audit = db.auditLog.create.mock.calls.at(-1)?.[0]?.data;
    expect(audit?.action).toBe("catalog.product.option_extended");
  });

  it("backfills every existing variant atomically and recomputes optionSignature", async () => {
    wire(db, {
      existingVariants: [
        { id: "v1", optionValues: [{ optionValueId: "size_s" }] },
        { id: "v2", optionValues: [{ optionValueId: "size_m" }] },
      ],
    });
    await extendProductOption(
      manager,
      "prod_1",
      {
        ...baseInput,
        backfill: [
          { variantId: "v1", value: "White" },
          { variantId: "v2", value: "Black" },
        ],
      },
      {},
      db,
    );

    expect(db.productVariantOptionValue.create).toHaveBeenCalledTimes(2);
    expect(db.productVariantOptionValue.create).toHaveBeenCalledWith({
      data: { variantId: "v1", optionId: "opt_new", optionValueId: "val_White" },
    });
    expect(db.productVariantOptionValue.create).toHaveBeenCalledWith({
      data: { variantId: "v2", optionId: "opt_new", optionValueId: "val_Black" },
    });

    expect(db.productVariant.update).toHaveBeenCalledWith({
      where: { id: "v1" },
      data: { optionSignature: ["size_s", "val_White"].sort().join("|") },
    });
    expect(db.productVariant.update).toHaveBeenCalledWith({
      where: { id: "v2" },
      data: { optionSignature: ["size_m", "val_Black"].sort().join("|") },
    });
  });

  it("rejects when backfilling would collide two variants onto the same signature", async () => {
    // Two variants that already (invalidly) share the same option-value set —
    // exercises the defensive duplicate-signature check.
    wire(db, {
      existingVariants: [
        { id: "v1", optionValues: [{ optionValueId: "size_s" }] },
        { id: "v2", optionValues: [{ optionValueId: "size_s" }] },
      ],
    });
    await expect(
      extendProductOption(
        manager,
        "prod_1",
        {
          ...baseInput,
          backfill: [
            { variantId: "v1", value: "White" },
            { variantId: "v2", value: "White" },
          ],
        },
        {},
        db,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
