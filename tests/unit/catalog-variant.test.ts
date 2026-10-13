// @vitest-environment node
import { UserRole } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ForbiddenError, UnauthenticatedError } from "@/server/auth/errors";
import {
  CatalogValidationError,
  ConflictError,
  ReferentialIntegrityError,
} from "@/server/catalog/errors";
import { createVariant } from "@/server/catalog/variant-service";
import { createMockPrisma, looseMock, type MockPrisma } from "./helpers/mock-prisma";

const manager = { id: "mgr", role: UserRole.MANAGER };
const staff = { id: "stf", role: UserRole.STAFF };

interface Scenario {
  skuTaken?: boolean;
  signatureTaken?: boolean;
  productOptions?: { id: string; name: string }[];
  /** Existing option name -> id, for options that already exist on the product. */
  existingOptions?: Record<string, string>;
  /** Other variants the product already has (excludes the one being created). */
  otherVariantCount?: number;
}

function wire(db: MockPrisma, scenario: Scenario = {}) {
  db.product.findUnique.mockResolvedValue({ id: "prod_1" } as never);
  db.productOption.findMany.mockResolvedValue((scenario.productOptions ?? []) as never);
  db.productVariant.count.mockResolvedValue(scenario.otherVariantCount ?? 0);
  looseMock(db.productOption.findUnique).mockImplementation(({ where }) => {
    const name = where.productId_name.name as string;
    const existingId = scenario.existingOptions?.[name];
    return Promise.resolve(existingId ? { id: existingId, _count: { values: 0 } } : null);
  });
  looseMock(db.productOption.create).mockImplementation(({ data }) =>
    Promise.resolve({ id: `opt_${data.name}`, _count: { values: 0 } }),
  );
  looseMock(db.productOptionValue.upsert).mockImplementation(({ where }) =>
    Promise.resolve({ id: `val_${where.optionId_value.value}` }),
  );
  looseMock(db.productVariant.findUnique).mockImplementation((args) => {
    const where = args.where ?? {};
    if ("sku" in where) return Promise.resolve(scenario.skuTaken ? { id: "other" } : null);
    if ("barcode" in where) return Promise.resolve(null);
    if ("productId_optionSignature" in where) {
      return Promise.resolve(scenario.signatureTaken ? { id: "dupe", sku: "DUPE-1" } : null);
    }
    return Promise.resolve(null);
  });
  db.productVariant.create.mockResolvedValue({
    id: "var_1",
    sku: "NEW-SKU-1",
    priceCents: 1999,
    inventoryItem: { id: "inv_1" },
  } as never);
  db.stockMovement.create.mockResolvedValue({ id: "mv" } as never);
  db.auditLog.create.mockResolvedValue({ id: "a" } as never);
}

const baseInput = {
  sku: "NEW-SKU-1",
  priceCents: 1999,
  position: 0,
  active: true,
  trackInventory: true,
  initialQuantity: 0,
  optionSelections: [],
};

describe("createVariant", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
    vi.clearAllMocks();
  });

  it("requires the catalog.write permission", async () => {
    wire(db);
    await expect(createVariant(null, "prod_1", { ...baseInput }, db)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    await expect(createVariant(staff, "prod_1", { ...baseInput }, db)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("rejects a SKU that is already in use", async () => {
    wire(db, { skuTaken: true });
    await expect(createVariant(manager, "prod_1", { ...baseInput }, db)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("rejects a duplicate option combination for the product", async () => {
    wire(db, { signatureTaken: true });
    await expect(createVariant(manager, "prod_1", { ...baseInput }, db)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("requires a value for every product option", async () => {
    wire(db, { productOptions: [{ id: "opt_Size", name: "Size" }] });
    await expect(
      createVariant(manager, "prod_1", { ...baseInput, optionSelections: [] }, db),
    ).rejects.toBeInstanceOf(CatalogValidationError);
  });

  it("allows selecting an existing option's value even when other variants exist", async () => {
    wire(db, {
      productOptions: [{ id: "opt_Size", name: "Size" }],
      existingOptions: { Size: "opt_Size" },
      otherVariantCount: 3,
    });
    const variant = await createVariant(
      manager,
      "prod_1",
      { ...baseInput, optionSelections: [{ option: "Size", value: "L" }] },
      db,
    );
    expect(variant.id).toBe("var_1");
  });

  it("refuses to implicitly create a brand-new option when the product already has other variants", async () => {
    wire(db, { otherVariantCount: 1 });
    await expect(
      createVariant(
        manager,
        "prod_1",
        { ...baseInput, optionSelections: [{ option: "Colour", value: "Red" }] },
        db,
      ),
    ).rejects.toBeInstanceOf(ReferentialIntegrityError);
  });

  it("rejects compare-at price <= selling price", async () => {
    wire(db);
    await expect(
      createVariant(
        manager,
        "prod_1",
        { ...baseInput, priceCents: 1999, compareAtPriceCents: 1999 },
        db,
      ),
    ).rejects.toBeInstanceOf(CatalogValidationError);
  });

  it("creates the variant (+ inventory item) and audits it", async () => {
    wire(db, { productOptions: [{ id: "opt_Size", name: "Size" }] });
    const variant = await createVariant(
      manager,
      "prod_1",
      { ...baseInput, optionSelections: [{ option: "Size", value: "M" }], initialQuantity: 5 },
      db,
    );
    expect(variant.id).toBe("var_1");
    const createArg = db.productVariant.create.mock.calls[0]![0].data;
    expect(createArg).toMatchObject({
      sku: "NEW-SKU-1",
      priceCents: 1999,
      optionSignature: "val_M",
    });
    expect(createArg.inventoryItem).toBeDefined();
    expect(db.stockMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ quantityDelta: 5 }) }),
    );
    const audit = db.auditLog.create.mock.calls.at(-1)?.[0]?.data;
    expect(audit?.action).toBe("catalog.variant.created");
  });
});
