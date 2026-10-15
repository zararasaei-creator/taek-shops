import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The storefront home page is a data-driven Server Component (Phase 6 product grid, redesigned
 * as a sports-retail landing page). The catalogue query is mocked so the component can render in
 * jsdom without a database. Assertions cover: the single level-1 heading, the empty state, real
 * product listing with a formatted price, the honest no-photo fallback, the primary image, and
 * that category tiles only link when a published product actually belongs to them.
 */
const { listPublicProducts } = vi.hoisted(() => ({ listPublicProducts: vi.fn() }));
vi.mock("@/server/catalog/catalog-queries", () => ({ listPublicProducts }));

import HomePage from "@/app/(storefront)/page";

const product = (overrides: Record<string, unknown> = {}) => ({
  id: "p1",
  name: "Student Dobok",
  slug: "student-dobok",
  description: null,
  brand: { name: "Taek Basics", slug: "taek-basics" },
  category: { name: "Uniforms", slug: "uniforms" },
  priceRange: { minCents: 3999, maxCents: 4499 },
  images: [],
  ...overrides,
});

describe("storefront home page", () => {
  beforeEach(() => {
    listPublicProducts.mockReset();
  });

  it("renders one level-1 heading, the hero call to action, and an empty state when there are no products", async () => {
    listPublicProducts.mockResolvedValue({ products: [], total: 0 });
    render(await HomePage());
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/ready for your next level/i);
    expect(screen.getByRole("link", { name: /shop the collection/i })).toHaveAttribute("href", "#products");
    expect(screen.getByText(/no products are available/i)).toBeInTheDocument();
  });

  it("lists a product with a formatted price, falling back to an honest placeholder when there's no image", async () => {
    listPublicProducts.mockResolvedValue({ products: [product()], total: 1 });
    render(await HomePage());
    expect(screen.getByRole("heading", { level: 3, name: "Student Dobok" })).toBeInTheDocument();
    expect(screen.getByText("$39.99 – $44.99")).toBeInTheDocument();
    expect(screen.getByLabelText("No image available")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /student dobok/i })).toHaveAttribute(
      "href",
      "/products/student-dobok",
    );
  });

  it("renders the primary image when one exists", async () => {
    listPublicProducts.mockResolvedValue({
      products: [
        product({
          images: [{ url: "http://fake-storage.local/products/p1/a.jpg", altText: "Front view", isPrimary: true }],
        }),
      ],
      total: 1,
    });
    render(await HomePage());
    expect(screen.getByAltText("Front view")).toBeInTheDocument();
    expect(screen.queryByLabelText("No image available")).not.toBeInTheDocument();
  });

  it("only links a category tile when a published product belongs to it; the others say so", async () => {
    listPublicProducts.mockResolvedValue({ products: [product()], total: 1 });
    render(await HomePage());
    const tiles = screen.getByRole("heading", { level: 2, name: /shop by category/i }).closest("section")!;

    const uniforms = within(tiles).getByRole("link", { name: /uniforms/i });
    expect(uniforms).toHaveAttribute("href", "#products");
    expect(uniforms).toHaveTextContent(/1 product available/i);

    // Footwear, Belts and Protective Gear have nothing published: no link, explicit status.
    for (const title of ["Footwear", "Belts", "Protective Gear"]) {
      expect(within(tiles).queryByRole("link", { name: new RegExp(title, "i") })).not.toBeInTheDocument();
      expect(within(tiles).getByRole("heading", { level: 3, name: title })).toBeInTheDocument();
    }
    expect(within(tiles).getAllByText(/no products listed yet/i)).toHaveLength(3);
  });

  it("has working in-page anchors for every section the hero and about areas point at", async () => {
    listPublicProducts.mockResolvedValue({ products: [product()], total: 1 });
    const { container } = render(await HomePage());
    const targets = Array.from(container.querySelectorAll('a[href^="#"]')).map((a) => a.getAttribute("href")!);
    expect(targets.length).toBeGreaterThan(0);
    for (const href of new Set(targets)) {
      expect(container.querySelector(href), `missing anchor target ${href}`).not.toBeNull();
    }
  });
});
