// @vitest-environment node
import { ImportJobStatus, ImportRowStatus, UserRole } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { ForbiddenError, UnauthenticatedError } from "@/server/auth/errors";
import { ImportFileError } from "@/server/import/errors";
import { commitImport, previewImport } from "@/server/import/product-import-service";
import { createMockPrisma, type MockPrisma } from "./helpers/mock-prisma";

const manager = { id: "mgr", role: UserRole.MANAGER };
const staff = { id: "stf", role: UserRole.STAFF };

const HEADER = "sku,product_name,price,option1_name,option1_value\n";
const enc = (text: string) => new TextEncoder().encode(text);

describe("previewImport (dry-run)", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
    db.productVariant.findMany.mockResolvedValue([{ sku: "EXISTING-1" }] as never);
    db.importJob.create.mockResolvedValue({ id: "job_1" } as never);
    db.auditLog.create.mockResolvedValue({ id: "a" } as never);
  });

  it("requires the import.run permission", async () => {
    await expect(
      previewImport(null, { filename: "p.csv", bytes: enc(HEADER + "A-1,Uniform,9.99,,\n") }, db),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(
      previewImport(staff, { filename: "p.csv", bytes: enc(HEADER + "A-1,Uniform,9.99,,\n") }, db),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("writes NOTHING to the catalogue and persists an ImportJob", async () => {
    const csv = HEADER + "NEW-1,New Uniform,39.99,Size,140\nEXISTING-1,Existing,19.99,Size,S\n";
    const preview = await previewImport(manager, { filename: "products.csv", bytes: enc(csv) }, db);

    for (const model of [
      "product",
      "productVariant",
      "brand",
      "category",
      "inventoryItem",
      "stockMovement",
    ] as const) {
      expect(db[model].create).not.toHaveBeenCalled();
      expect(db[model].update).not.toHaveBeenCalled();
    }
    expect(db.importJob.create).toHaveBeenCalledOnce();
    const jobData = db.importJob.create.mock.calls[0]![0].data;
    expect(jobData).toMatchObject({
      status: ImportJobStatus.VALIDATED,
      totalRows: 2,
      mode: "upsert",
    });
    expect(preview.counts).toEqual({ create: 1, update: 1, error: 0 });
    expect(db.auditLog.create.mock.calls.at(-1)?.[0]?.data?.action).toBe(
      "import.product.previewed",
    );
  });

  it("classifies an existing SKU as an update", async () => {
    const preview = await previewImport(
      manager,
      { filename: "p.csv", bytes: enc(HEADER + "EXISTING-1,Existing,29.99,,\n") },
      db,
    );
    expect(preview.rows[0]).toMatchObject({ action: "update" });
  });

  it("flags a duplicate SKU within the file and an invalid row", async () => {
    const csv = HEADER + "DUP-1,A,9.99,,\n" + "DUP-1,A,9.99,,\n" + "BAD-1,B,not-a-price,,\n";
    const preview = await previewImport(manager, { filename: "p.csv", bytes: enc(csv) }, db);

    expect(preview.rows[1]!.errors.map((e) => e.code)).toContain("duplicate_sku_in_file");
    expect(preview.rows[2]!.action).toBe("error");
    expect(preview.counts.error).toBe(2);
  });

  it("aborts the whole file when a required column is missing", async () => {
    await expect(
      previewImport(manager, { filename: "p.csv", bytes: enc("sku,product_name\nA-1,X\n") }, db),
    ).rejects.toThrow(/Missing required column/);
  });

  it("rejects a known-but-unsupported spreadsheet format before parsing", async () => {
    // .xlsx graduated to supported this pass (see import-xlsx-service tests);
    // .xlsm remains explicitly refused.
    await expect(
      previewImport(
        manager,
        { filename: "catalog.xlsm", bytes: enc(HEADER + "A-1,X,9.99,,\n") },
        db,
      ),
    ).rejects.toThrow(/csv|xlsx/i);
  });

  it("warns when a row uses a value the existing product doesn't declare for that option", async () => {
    db.product.findUnique.mockResolvedValue({
      options: [{ name: "EU Size", values: [{ value: "38" }, { value: "39" }] }],
    } as never);
    const csv =
      "sku,product_name,product_slug,price,option1_name,option1_value\n" +
      "SHOE-EU-40,Adult Shoe,adult-shoe,59.99,EU Size,40\n";
    const preview = await previewImport(manager, { filename: "p.csv", bytes: enc(csv) }, db);

    expect(preview.rows[0]!.action).not.toBe("error");
    expect(preview.rows[0]!.warnings.join(" ")).toMatch(/new value for the existing option/i);
  });

  it("does not warn when the value is already declared for that option", async () => {
    db.product.findUnique.mockResolvedValue({
      options: [{ name: "EU Size", values: [{ value: "38" }, { value: "39" }, { value: "40" }] }],
    } as never);
    const csv =
      "sku,product_name,product_slug,price,option1_name,option1_value\n" +
      "SHOE-EU-40,Adult Shoe,adult-shoe,59.99,EU Size,40\n";
    const preview = await previewImport(manager, { filename: "p.csv", bytes: enc(csv) }, db);
    expect(preview.rows[0]!.warnings.join(" ")).not.toMatch(/new value/i);
  });
});

describe("commitImport (guards + row isolation)", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
    db.auditLog.create.mockResolvedValue({ id: "a" } as never);
  });

  it("404s an unknown job", async () => {
    db.importJob.findUnique.mockResolvedValue(null);
    await expect(commitImport(manager, "missing", {}, db)).rejects.toBeInstanceOf(ImportFileError);
  });

  it("refuses to commit a job that is not VALIDATED", async () => {
    db.importJob.findUnique.mockResolvedValue({
      id: "job_1",
      status: ImportJobStatus.COMPLETED,
      type: "PRODUCT",
    } as never);
    await expect(commitImport(manager, "job_1", {}, db)).rejects.toThrow(
      /can no longer be committed/,
    );
  });

  it("keeps invalid staged rows out of the catalogue and reports them", async () => {
    db.importJob.findUnique.mockResolvedValue({
      id: "job_1",
      status: ImportJobStatus.VALIDATED,
      type: "PRODUCT",
    } as never);
    db.importJob.update.mockResolvedValue({} as never);
    db.importJob.findUniqueOrThrow.mockReturnValue({
      rows: () =>
        Promise.resolve([
          {
            id: "row_1",
            rowNumber: 2,
            sku: "BAD-1",
            status: ImportRowStatus.PENDING,
            rawData: { raw: { sku: "BAD-1", product_name: "X", price: "nope" } },
          },
        ]),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    db.importJobRow.update.mockResolvedValue({} as never);

    const result = await commitImport(manager, "job_1", {}, db);

    expect(result.counts).toEqual({ created: 0, updated: 0, skipped: 0, failed: 1 });
    expect(result.status).toBe(ImportJobStatus.FAILED);
    expect(db.product.create).not.toHaveBeenCalled();
    expect(db.productVariant.create).not.toHaveBeenCalled();
    expect(db.importJobRow.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: ImportRowStatus.FAILED }),
      }),
    );
    expect(db.auditLog.create.mock.calls.at(-1)?.[0]?.data?.action).toBe(
      "import.product.committed",
    );
  });

  it("refuses a new option column for an existing product that already has other variants", async () => {
    db.importJob.findUnique.mockResolvedValue({
      id: "job_1",
      status: ImportJobStatus.VALIDATED,
      type: "PRODUCT",
    } as never);
    db.importJob.update.mockResolvedValue({} as never);
    db.importJob.findUniqueOrThrow.mockReturnValue({
      rows: () =>
        Promise.resolve([
          {
            id: "row_1",
            rowNumber: 2,
            sku: "NEW-COLOUR-1",
            status: ImportRowStatus.PENDING,
            rawData: {
              raw: {
                sku: "NEW-COLOUR-1",
                product_name: "Existing Product",
                price: "19.99",
                option1_name: "Colour",
                option1_value: "Red",
              },
            },
          },
        ]),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    db.importJobRow.update.mockResolvedValue({} as never);

    // The row's product already exists and already has other variants; the
    // "Colour" option is brand-new to it (findUnique returns null).
    db.product.findUnique.mockResolvedValue({
      id: "prod_1",
      description: null,
      brandId: null,
      categoryId: null,
    } as never);
    db.productVariant.count.mockResolvedValue(2);
    db.productVariant.findUnique.mockResolvedValue(null);
    db.productOption.findUnique.mockResolvedValue(null);

    const result = await commitImport(manager, "job_1", {}, db);

    expect(result.counts.failed).toBe(1);
    expect(db.product.create).not.toHaveBeenCalled();
    expect(db.productVariant.create).not.toHaveBeenCalled();
    const rowUpdate = db.importJobRow.update.mock.calls.at(-1)?.[0]?.data;
    expect(rowUpdate?.status).toBe(ImportRowStatus.FAILED);
    expect(JSON.stringify(rowUpdate?.errors)).toMatch(
      /extend options|does not exist on this product/,
    );
  });
});
