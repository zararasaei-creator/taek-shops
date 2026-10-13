// @vitest-environment node
import { UserRole } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ForbiddenError, UnauthenticatedError } from "@/server/auth/errors";
import { ConflictError } from "@/server/catalog/errors";
import { generateVariantMatrix } from "@/server/catalog/variant-service";
import { createMockPrisma, looseMock, type MockPrisma } from "./helpers/mock-prisma";

const manager = { id: "mgr", role: UserRole.MANAGER };
const staff = { id: "stf", role: UserRole.STAFF };

function wire(db: MockPrisma) {
  db.product.findUnique.mockResolvedValue({ id: "prod_1" } as never);
  db.productOption.findMany.mockResolvedValue([
    { id: "opt_Size", name: "Size" },
    { id: "opt_Colour", name: "Colour" },
  ] as never);
  db.productVariant.count.mockResolvedValue(0);
  looseMock(db.productOption.findUnique).mockImplementation(({ where }) => {
    const name = where.productId_name.name as string;
    return Promise.resolve({ id: `opt_${name}`, _count: { values: 0 } } as never);
  });
  looseMock(db.productOptionValue.upsert).mockImplementation(({ where }) =>
    Promise.resolve({ id: `val_${where.optionId_value.value}` } as never),
  );
  db.productVariant.findUnique.mockResolvedValue(null as never);
  let n = 0;
  looseMock(db.productVariant.create).mockImplementation(({ data }) => {
    n += 1;
    return Promise.resolve({
      id: `var_${n}`,
      sku: data.sku,
      priceCents: data.priceCents,
      inventoryItem: { id: `inv_${n}` },
    } as never);
  });
  db.stockMovement.create.mockResolvedValue({ id: "mv" } as never);
  db.auditLog.create.mockResolvedValue({ id: "a" } as never);
}

function cell(sku: string, size: string, colour: string) {
  return {
    sku,
    priceCents: 3000,
    position: 0,
    active: true,
    trackInventory: true,
    initialQuantity: 5,
    optionSelections: [
      { option: "Size", value: size },
      { option: "Colour", value: colour },
    ],
  };
}

describe("generateVariantMatrix", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
    vi.clearAllMocks();
  });

  it("requires the catalog.write permission", async () => {
    wire(db);
    const input = { cells: [cell("SKU-1", "S", "White")] };
    await expect(generateVariantMatrix(null, "prod_1", input, db)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    await expect(generateVariantMatrix(staff, "prod_1", input, db)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("rejects duplicate SKUs within the batch before touching the database", async () => {
    wire(db);
    const input = { cells: [cell("SKU-1", "S", "White"), cell("SKU-1", "M", "Black")] };
    await expect(generateVariantMatrix(manager, "prod_1", input, db)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(db.productVariant.create).not.toHaveBeenCalled();
  });

  it("rejects duplicate option combinations within the batch", async () => {
    wire(db);
    const input = { cells: [cell("SKU-1", "S", "White"), cell("SKU-2", "S", "White")] };
    await expect(generateVariantMatrix(manager, "prod_1", input, db)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(db.productVariant.create).not.toHaveBeenCalled();
  });

  it("bulk-creates every cell atomically and records one summary audit event", async () => {
    wire(db);
    const input = {
      cells: [
        cell("SKU-S-WHITE", "S", "White"),
        cell("SKU-M-WHITE", "M", "White"),
        cell("SKU-S-BLACK", "S", "Black"),
      ],
    };
    const variants = await generateVariantMatrix(manager, "prod_1", input, db);
    expect(variants).toHaveLength(3);
    expect(variants.map((v) => v.sku)).toEqual(["SKU-S-WHITE", "SKU-M-WHITE", "SKU-S-BLACK"]);
    expect(db.stockMovement.create).toHaveBeenCalledTimes(3);

    const audit = db.auditLog.create.mock.calls.at(-1)?.[0]?.data;
    expect(audit?.action).toBe("catalog.variant.matrix_generated");
    expect(audit?.metadata).toMatchObject({ count: 3 });
  });

  it("propagates a mid-batch failure so nothing is reported created", async () => {
    wire(db);
    looseMock(db.productVariant.findUnique).mockImplementation((args) => {
      const where = args.where ?? {};
      if ("sku" in where && where.sku === "SKU-M-WHITE") {
        return Promise.resolve({ id: "already-there" } as never);
      }
      return Promise.resolve(null);
    });
    const input = {
      cells: [cell("SKU-S-WHITE", "S", "White"), cell("SKU-M-WHITE", "M", "White")],
    };
    await expect(generateVariantMatrix(manager, "prod_1", input, db)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });
});
