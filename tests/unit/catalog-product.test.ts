// @vitest-environment node
import { ProductStatus, UserRole } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { ForbiddenError, UnauthenticatedError } from "@/server/auth/errors";
import { ConflictError, InvalidStateTransitionError, NotFoundError } from "@/server/catalog/errors";
import { changeProductStatus, createProduct, listProducts } from "@/server/catalog/product-service";
import { createMockPrisma, type MockPrisma } from "./helpers/mock-prisma";

const manager = { id: "mgr", role: UserRole.MANAGER };
const staff = { id: "stf", role: UserRole.STAFF };
const customer = { id: "cus", role: UserRole.CUSTOMER };

describe("product authorization", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
    db.product.findMany.mockResolvedValue([] as never);
    db.product.count.mockResolvedValue(0 as never);
  });

  it("listProducts needs catalog.read (STAFF+)", async () => {
    await expect(listProducts(null, {}, db)).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(listProducts(customer, {}, db)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listProducts(staff, {}, db)).resolves.toEqual({ products: [], total: 0 });
  });

  it("createProduct needs catalog.write (MANAGER+)", async () => {
    await expect(
      createProduct(staff, { name: "X", featured: false, status: ProductStatus.DRAFT }, db),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("createProduct", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
    db.product.findUnique.mockResolvedValue(null);
    db.product.create.mockResolvedValue({ id: "prod_1" } as never);
    db.product.findUniqueOrThrow.mockResolvedValue({
      id: "prod_1",
      name: "Student Uniform",
      slug: "student-uniform",
      status: ProductStatus.DRAFT,
      variants: [],
    } as never);
    db.auditLog.create.mockResolvedValue({ id: "a" } as never);
  });

  it("derives a slug, defaults to DRAFT, and audits", async () => {
    const product = await createProduct(manager, { name: "Student Uniform" }, db);
    expect(db.product.create.mock.calls[0]![0].data).toMatchObject({
      slug: "student-uniform",
      status: ProductStatus.DRAFT,
      active: false,
    });
    expect(product.id).toBe("prod_1");
    expect(db.auditLog.create.mock.calls.at(-1)?.[0]?.data?.action).toBe("catalog.product.created");
  });

  it("rejects a duplicate slug", async () => {
    db.product.findUnique.mockResolvedValue({ id: "other" } as never);
    await expect(createProduct(manager, { name: "Student Uniform" }, db)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("refuses ACTIVE status without a default variant", async () => {
    await expect(
      createProduct(manager, { name: "X", status: ProductStatus.ACTIVE }, db),
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });
});

describe("changeProductStatus", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
    db.auditLog.create.mockResolvedValue({ id: "a" } as never);
  });

  it("requires an active variant to publish", async () => {
    db.product.findUnique.mockResolvedValue({ status: ProductStatus.DRAFT } as never);
    db.productVariant.count.mockResolvedValue(0 as never);
    await expect(
      changeProductStatus(manager, "prod_1", ProductStatus.ACTIVE, {}, db),
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
  });

  it("publishes when a variant exists and mirrors `active`", async () => {
    db.product.findUnique.mockResolvedValue({ status: ProductStatus.DRAFT } as never);
    db.productVariant.count.mockResolvedValue(2 as never);
    db.product.update.mockResolvedValue({} as never);
    db.product.findUniqueOrThrow.mockResolvedValue({
      id: "prod_1",
      status: ProductStatus.ACTIVE,
      variants: [],
    } as never);

    await changeProductStatus(manager, "prod_1", ProductStatus.ACTIVE, {}, db);
    expect(db.product.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: ProductStatus.ACTIVE, active: true }),
      }),
    );
  });

  it("throws NotFound for a missing product", async () => {
    db.product.findUnique.mockResolvedValue(null);
    await expect(
      changeProductStatus(manager, "missing", ProductStatus.ARCHIVED, {}, db),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
