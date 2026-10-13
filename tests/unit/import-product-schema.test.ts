// @vitest-environment node
import { ProductStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { parseProductRow } from "@/server/import/product-import-schema";

const baseRow = {
  sku: "UNI-STU-WHT-140",
  product_name: "Student Taekwondo Uniform",
  price: "39.99",
};

function codes(errors: { code: string }[]): string[] {
  return errors.map((e) => e.code).sort();
}

describe("parseProductRow", () => {
  it("normalises a minimal valid row", () => {
    const { data, errors } = parseProductRow({ ...baseRow });
    expect(errors).toEqual([]);
    expect(data).toMatchObject({
      sku: "UNI-STU-WHT-140",
      productName: "Student Taekwondo Uniform",
      productSlug: "student-taekwondo-uniform",
      status: ProductStatus.DRAFT,
      priceCents: 3999,
      options: [],
    });
  });

  it("stores money as exact integer cents", () => {
    expect(parseProductRow({ ...baseRow, price: "18.50" }).data?.priceCents).toBe(1850);
    expect(parseProductRow({ ...baseRow, price: "1,000" }).data?.priceCents).toBe(100000);
    expect(codes(parseProductRow({ ...baseRow, price: "39.999" }).errors)).toContain(
      "invalid_amount",
    );
    expect(codes(parseProductRow({ ...baseRow, price: "0" }).errors)).toContain("not_positive");
  });

  it("requires sku, product_name and price", () => {
    expect(codes(parseProductRow({}).errors)).toEqual(["required", "required", "required"]);
  });

  it("validates sku format and length", () => {
    expect(codes(parseProductRow({ ...baseRow, sku: "ab" }).errors)).toContain("length");
    expect(codes(parseProductRow({ ...baseRow, sku: "a b c" }).errors)).toContain("format");
    expect(codes(parseProductRow({ ...baseRow, sku: "-bad" }).errors)).toContain("format");
  });

  it("rejects compare_at_price <= price", () => {
    expect(codes(parseProductRow({ ...baseRow, compare_at_price: "39.99" }).errors)).toContain(
      "not_greater",
    );
    expect(parseProductRow({ ...baseRow, compare_at_price: "49.99" }).errors).toEqual([]);
  });

  it("reads on-hand inventory from inventory_on_hand", () => {
    expect(parseProductRow({ ...baseRow, inventory_on_hand: "5" }).data?.inventoryOnHand).toBe(5);
    expect(parseProductRow({ ...baseRow, inventory_on_hand: "0" }).data?.inventoryOnHand).toBe(0);
    expect(parseProductRow({ ...baseRow }).data?.inventoryOnHand).toBeUndefined();
    expect(codes(parseProductRow({ ...baseRow, inventory_on_hand: "-3" }).errors)).toContain(
      "out_of_range",
    );
    expect(codes(parseProductRow({ ...baseRow, inventory_on_hand: "abc" }).errors)).toContain(
      "invalid_integer",
    );
  });

  it("still accepts the legacy inventory_quantity header as an alias", () => {
    expect(parseProductRow({ ...baseRow, inventory_quantity: "7" }).data?.inventoryOnHand).toBe(7);
    // Canonical wins when both are present.
    expect(
      parseProductRow({ ...baseRow, inventory_on_hand: "9", inventory_quantity: "7" }).data
        ?.inventoryOnHand,
    ).toBe(9);
  });

  it("maps status case-insensitively and rejects unknowns", () => {
    expect(parseProductRow({ ...baseRow, status: "Active" }).data?.status).toBe(
      ProductStatus.ACTIVE,
    );
    expect(codes(parseProductRow({ ...baseRow, status: "live" }).errors)).toContain("invalid_enum");
  });

  it("collects up to three option pairs, not limited to Size/Colour", () => {
    const { data } = parseProductRow({
      ...baseRow,
      option1_name: "Size",
      option1_value: "140",
      option2_name: "Material",
      option2_value: "Ripstop",
    });
    expect(data?.options).toEqual([
      { name: "Size", value: "140" },
      { name: "Material", value: "Ripstop" },
    ]);
  });

  it("flags incomplete and duplicate option pairs", () => {
    expect(codes(parseProductRow({ ...baseRow, option1_name: "Size" }).errors)).toContain(
      "incomplete_option",
    );
    expect(
      codes(
        parseProductRow({
          ...baseRow,
          option1_name: "Size",
          option1_value: "S",
          option2_name: "size",
          option2_value: "M",
        }).errors,
      ),
    ).toContain("duplicate_option");
  });

  it("requires https image URLs", () => {
    expect(codes(parseProductRow({ ...baseRow, image_url: "http://x/y.jpg" }).errors)).toContain(
      "not_https",
    );
    expect(codes(parseProductRow({ ...baseRow, image_url: "not a url" }).errors)).toContain(
      "invalid_url",
    );
    expect(
      parseProductRow({ ...baseRow, image_url: "https://cdn.example.com/a.jpg" }).data?.imageUrl,
    ).toBe("https://cdn.example.com/a.jpg");
  });

  it("parses a variant-level image URL independently of the product image", () => {
    const { data, errors } = parseProductRow({
      ...baseRow,
      image_url: "https://cdn.example.com/product.jpg",
      variant_image_url: "https://cdn.example.com/variant-140.jpg",
    });
    expect(errors).toEqual([]);
    expect(data?.imageUrl).toBe("https://cdn.example.com/product.jpg");
    expect(data?.variantImageUrl).toBe("https://cdn.example.com/variant-140.jpg");
  });

  it("validates variant_image_url the same way as image_url", () => {
    expect(
      codes(parseProductRow({ ...baseRow, variant_image_url: "http://x/y.jpg" }).errors),
    ).toContain("not_https");
    expect(codes(parseProductRow({ ...baseRow, variant_image_url: "nope" }).errors)).toContain(
      "invalid_url",
    );
    const clean = parseProductRow({ ...baseRow });
    expect(clean.data?.variantImageUrl).toBeUndefined();
  });
});
