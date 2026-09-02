import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HomePage from "@/app/(storefront)/page";

describe("storefront home page", () => {
  it("renders the level-1 heading", () => {
    render(<HomePage />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/taekwondo journey/i);
  });
});
