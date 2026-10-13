// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { VariantMatrixGenerator } from "@/app/admin/catalog/products/[id]/variant-matrix-generator";

const SIZES = ["100", "110", "120", "130", "140", "150", "160", "170", "180", "190"];
const COLORS = ["White", "Black", "Multicolor"];

const options = [
  {
    id: "opt_size",
    name: "Size",
    values: SIZES.map((v) => ({ id: `size_${v}`, value: v })),
  },
  {
    id: "opt_colour",
    name: "Colour",
    values: COLORS.map((v) => ({ id: `colour_${v}`, value: v })),
  },
];

function selectEverything() {
  for (const value of SIZES) {
    fireEvent.click(screen.getByRole("checkbox", { name: value }));
  }
  for (const value of COLORS) {
    fireEvent.click(screen.getByRole("checkbox", { name: value }));
  }
}

describe("VariantMatrixGenerator — base price propagation", () => {
  it("copies a valid base price into every generated preview row (10 Size x 3 Colour = 30 rows)", () => {
    render(
      <VariantMatrixGenerator
        productId="prod_1"
        productSlug="dobok"
        options={options}
        existingSignatures={[]}
      />,
    );

    selectEverything();
    fireEvent.change(screen.getByPlaceholderText("39.99"), { target: { value: "39.99" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview matrix" }));

    const table = screen.getByRole("table");
    const priceInputs = within(table).getAllByDisplayValue("39.99");
    // 30 combinations, each with the base price pre-filled.
    expect(priceInputs).toHaveLength(30);
    expect(screen.queryByText("Every row needs a price.")).not.toBeInTheDocument();
  });

  it("still allows editing an individual row's price after preview", () => {
    render(
      <VariantMatrixGenerator
        productId="prod_1"
        productSlug="dobok"
        options={options}
        existingSignatures={[]}
      />,
    );

    selectEverything();
    fireEvent.change(screen.getByPlaceholderText("39.99"), { target: { value: "39.99" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview matrix" }));

    const rows = screen.getAllByRole("row").slice(1); // drop header row
    const firstRow = rows[0]!;
    const priceInput = within(firstRow).getByDisplayValue("39.99");
    fireEvent.change(priceInput, { target: { value: "49.99" } });
    expect(priceInput).toHaveValue("49.99");

    // Every other row keeps the base price.
    const table = screen.getByRole("table");
    expect(within(table).getAllByDisplayValue("39.99")).toHaveLength(29);
  });

  it("keeps a hand-edited row price when Preview matrix is clicked again", () => {
    render(
      <VariantMatrixGenerator
        productId="prod_1"
        productSlug="dobok"
        options={options}
        existingSignatures={[]}
      />,
    );

    selectEverything();
    fireEvent.change(screen.getByPlaceholderText("39.99"), { target: { value: "39.99" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview matrix" }));

    // Row 1 is "100 / White" — hand-edit its price.
    const firstRow = () => screen.getAllByRole("row")[1]!;
    within(firstRow()).getByText("100 / White");
    fireEvent.change(within(firstRow()).getByDisplayValue("39.99"), { target: { value: "44.99" } });

    // Re-preview.
    fireEvent.click(screen.getByRole("button", { name: "Preview matrix" }));

    // The edited row keeps 44.99; the other 29 rows still use the base price.
    expect(within(firstRow()).queryByDisplayValue("44.99")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getAllByDisplayValue("39.99")).toHaveLength(29);
    expect(within(table).getAllByDisplayValue("44.99")).toHaveLength(1);
  });

  it("re-previewing applies a changed base price to untouched rows but not to hand-edited ones", () => {
    render(
      <VariantMatrixGenerator
        productId="prod_1"
        productSlug="dobok"
        options={options}
        existingSignatures={[]}
      />,
    );

    selectEverything();
    fireEvent.change(screen.getByPlaceholderText("39.99"), { target: { value: "39.99" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview matrix" }));

    const firstRow = () => screen.getAllByRole("row")[1]!;
    fireEvent.change(within(firstRow()).getByDisplayValue("39.99"), { target: { value: "44.99" } });

    // Change the base price, then re-preview.
    fireEvent.change(screen.getByPlaceholderText("39.99"), { target: { value: "59.99" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview matrix" }));

    const table = screen.getByRole("table");
    expect(within(firstRow()).queryByDisplayValue("44.99")).toBeInTheDocument(); // edit preserved
    expect(within(table).getAllByDisplayValue("59.99")).toHaveLength(29); // untouched rows repriced
    expect(within(table).queryByDisplayValue("39.99")).not.toBeInTheDocument();
  });

  it("disables Preview matrix until a valid base price is entered", () => {
    render(
      <VariantMatrixGenerator
        productId="prod_1"
        productSlug="dobok"
        options={options}
        existingSignatures={[]}
      />,
    );

    selectEverything();
    const previewButton = screen.getByRole("button", { name: "Preview matrix" });
    expect(previewButton).toBeDisabled();
    expect(screen.getByText("Enter a base price above.")).toBeInTheDocument();

    // Clicking a disabled button fires no handler — no preview table appears.
    fireEvent.click(previewButton);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("39.99"), { target: { value: "39.99" } });
    expect(previewButton).toBeEnabled();
    fireEvent.click(previewButton);
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("still blocks creation when a row price is edited to become empty or invalid", () => {
    render(
      <VariantMatrixGenerator
        productId="prod_1"
        productSlug="dobok"
        options={options}
        existingSignatures={[]}
      />,
    );

    selectEverything();
    fireEvent.change(screen.getByPlaceholderText("39.99"), { target: { value: "39.99" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview matrix" }));

    const rows = screen.getAllByRole("row").slice(1);
    const priceInput = within(rows[0]!).getByDisplayValue("39.99");
    fireEvent.change(priceInput, { target: { value: "" } });

    expect(screen.getByText("Every row needs a price.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create \d+ variant/ })).toBeDisabled();
  });
});
