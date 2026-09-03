// @vitest-environment node
import { UserRole } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import { ForbiddenError, UnauthenticatedError } from "@/server/auth/errors";
import {
  CatalogValidationError,
  ConflictError,
  NotFoundError,
  ReferentialIntegrityError,
} from "@/server/catalog/errors";
import { createBrand, deleteBrandIfUnused } from "@/server/catalog/brand-service";
import {
  createCategory,
  deleteCategoryIfUnused,
  updateCategory,
} from "@/server/catalog/category-service";
import { createMockPrisma, looseMock, type MockPrisma } from "./helpers/mock-prisma";

const manager = { id: "mgr", role: UserRole.MANAGER };
const staff = { id: "stf", role: UserRole.STAFF };

describe("brand service", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
    db.auditLog.create.mockResolvedValue({ id: "a" } as never);
  });

  it("requires catalog.write to create", async () => {
    await expect(createBrand(staff, { name: "Taek Basics" }, db)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(createBrand(null, { name: "Taek Basics" }, db)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it("creates a brand with a derived slug", async () => {
    db.brand.findUnique.mockResolvedValue(null);
    db.brand.create.mockResolvedValue({
      id: "b1",
      name: "Taek Basics",
      slug: "taek-basics",
    } as never);
    const brand = await createBrand(manager, { name: "Taek Basics" }, db);
    expect(brand.slug).toBe("taek-basics");
    expect(db.auditLog.create.mock.calls.at(-1)?.[0]?.data?.action).toBe("catalog.brand.created");
  });

  it("rejects a duplicate brand name", async () => {
    db.brand.findUnique.mockResolvedValue({ id: "existing" } as never);
    await expect(createBrand(manager, { name: "Taek Basics" }, db)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("blocks hard-delete while products reference the brand", async () => {
    db.brand.findUnique.mockResolvedValue({ id: "b1", name: "Taek Basics" } as never);
    db.product.count.mockResolvedValue(3 as never);
    await expect(deleteBrandIfUnused(manager, "b1", {}, db)).rejects.toBeInstanceOf(
      ReferentialIntegrityError,
    );
    expect(db.brand.delete).not.toHaveBeenCalled();
  });
});

describe("category service", () => {
  let db: MockPrisma;
  beforeEach(() => {
    db = createMockPrisma();
    db.auditLog.create.mockResolvedValue({ id: "a" } as never);
  });

  it("rejects a non-existent parent on create", async () => {
    db.category.findUnique.mockResolvedValue(null);
    await expect(
      createCategory(manager, { name: "X", parentId: "missing" }, db),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects making a category its own parent on update", async () => {
    looseMock(db.category.findUnique).mockImplementation(({ where }) =>
      Promise.resolve(
        where.id === "c1" ? { id: "c1", slug: "c1", parentId: null } : { parentId: null },
      ),
    );
    await expect(updateCategory(manager, "c1", { parentId: "c1" }, db)).rejects.toBeInstanceOf(
      CatalogValidationError,
    );
  });

  it("blocks hard-delete while products or children reference the category", async () => {
    db.category.findUnique.mockResolvedValue({ id: "c1", name: "Uniforms" } as never);
    db.product.count.mockResolvedValue(0 as never);
    db.category.count.mockResolvedValue(2 as never);
    await expect(deleteCategoryIfUnused(manager, "c1", {}, db)).rejects.toBeInstanceOf(
      ReferentialIntegrityError,
    );
  });
});
