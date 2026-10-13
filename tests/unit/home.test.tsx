import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The storefront home page became a data-driven Server Component in Phase 6
 * (product grid). The catalogue query is mocked so the component can render in
 * jsdom without a database; the assertion — a level-1 heading and the product
 * listing — is unchanged in spirit from the Phase 1 shell test.
 */
const { listPublicProducts } = vi.hoisted(() => ({ listPublicProducts: vi.fn() }));
vi.mock("@/server/catalog/catalog-queries", () => ({ listPublicProducts }));

import HomePage from "@/app/(storefront)/page";

describe("storefront home page", () => {
  beforeEach(() => {
    listPublicProducts.mockReset();
  });

  it("renders the level-1 heading and an empty state when there are no products", async () => {
    listPublicProducts.mockResolvedValue({ products: [], total: 0 });
    render(await HomePage());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/taekwondo journey/i);
    expect(screen.getByText(/no products are available/i)).toBeInTheDocument();
  });

  it("lists products with a formatted price, falling back to a placeholder when there's no image", async () => {
    listPublicProducts.mockResolvedValue({
      products: [
        {
          id: "p1",
          name: "Student Dobok",
          slug: "student-dobok",
          brand: { name: "Taek Basics", slug: "taek-basics" },
          priceRange: { minCents: 3999, maxCents: 4499 },
          images: [],
        },
      ],
      total: 1,
    });
    render(await HomePage());
    expect(screen.getByRole("heading", { level: 2, name: "Student Dobok" })).toBeInTheDocument();
    expect(screen.getByText("$39.99 – $44.99")).toBeInTheDocument();
    expect(screen.getByLabelText("No image available")).toBeInTheDocument();
  });

  it("renders the primary image when one exists", async () => {
    listPublicProducts.mockResolvedValue({
      products: [
        {
          id: "p1",
          name: "Student Dobok",
          slug: "student-dobok",
          brand: { name: "Taek Basics", slug: "taek-basics" },
          priceRange: { minCents: 3999, maxCents: 4499 },
          images: [{ url: "http://fake-storage.local/products/p1/a.jpg", altText: "Front view", isPrimary: true }],
        },
      ],
      total: 1,
    });
    render(await HomePage());
    expect(screen.getByAltText("Front view")).toBeInTheDocument();
  });
});
