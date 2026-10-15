import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SiteFooter } from "@/components/storefront/site-footer";
import { SiteHeader } from "@/components/storefront/site-header";

/**
 * The storefront header/footer are presentational; the layout decides who is signed in and the
 * cart size. The e2e specs rely on these data-testid values and on the exact "Cart (N)" text, so
 * they are pinned here, together with the signed-in / signed-out link sets.
 */
describe("storefront header", () => {
  it("signed out: sign-in and create-account links, no account links", () => {
    render(<SiteHeader signedIn={false} cartCount={0} />);
    expect(screen.getByTestId("nav-sign-in")).toHaveAttribute("href", "/login?next=/account");
    expect(screen.getByTestId("nav-create-account")).toHaveAttribute("href", "/register");
    expect(screen.queryByTestId("nav-account")).not.toBeInTheDocument();
    expect(screen.queryByTestId("nav-my-orders")).not.toBeInTheDocument();
  });

  it("signed in: account and orders links, no sign-in links", () => {
    render(<SiteHeader signedIn cartCount={0} />);
    expect(screen.getByTestId("nav-account")).toHaveAttribute("href", "/account");
    expect(screen.getByTestId("nav-my-orders")).toHaveAttribute("href", "/account/orders");
    expect(screen.queryByTestId("nav-sign-in")).not.toBeInTheDocument();
    expect(screen.queryByTestId("nav-create-account")).not.toBeInTheDocument();
  });

  it("cart link keeps its exact text: 'Cart' when empty, 'Cart (N)' otherwise", () => {
    const { rerender } = render(<SiteHeader signedIn={false} cartCount={0} />);
    expect(screen.getByTestId("nav-cart")).toHaveTextContent(/^Cart$/);
    expect(screen.getByTestId("nav-cart")).toHaveAttribute("href", "/cart");
    rerender(<SiteHeader signedIn={false} cartCount={3} />);
    expect(screen.getByTestId("nav-cart")).toHaveTextContent(/^Cart \(3\)$/);
  });

  it("has in-page navigation to the home sections and uses no <img> (the product-image e2e takes the first <img>)", () => {
    const { container } = render(<SiteHeader signedIn={false} cartCount={0} />);
    expect(screen.getByRole("link", { name: "Shop" })).toHaveAttribute("href", "/#products");
    expect(screen.getByRole("link", { name: "Categories" })).toHaveAttribute("href", "/#categories");
    expect(screen.getByRole("link", { name: "About" })).toHaveAttribute("href", "/#about");
    expect(screen.getByRole("link", { name: "Taek Shops" })).toHaveAttribute("href", "/");
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("storefront footer", () => {
  it("shows the account links for the current state and the existing currency line", () => {
    const { container, rerender } = render(<SiteFooter signedIn={false} />);
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login?next=/account");
    expect(screen.getByRole("link", { name: "Create account" })).toHaveAttribute("href", "/register");
    expect(screen.getByText(/all prices in canadian dollars/i)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    rerender(<SiteFooter signedIn />);
    expect(screen.getByRole("link", { name: "My orders" })).toHaveAttribute("href", "/account/orders");
    expect(screen.queryByRole("link", { name: "Sign in" })).not.toBeInTheDocument();
  });
});
