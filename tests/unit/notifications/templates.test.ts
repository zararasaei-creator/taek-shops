// @vitest-environment node
import { describe, expect, it } from "vitest";

import { formatCents } from "@/server/domain/money";
import {
  escapeHtml,
  renderOrderConfirmationEmail,
  renderShippingNotificationEmail,
  type OrderEmailSnapshot,
} from "@/server/notifications";

// Synthetic customer/order details only — never real data.
const baseOrder: OrderEmailSnapshot = {
  orderNumber: "TS-TEST-0001",
  currency: "CAD",
  items: [
    {
      productName: "Sparring Gloves",
      variantName: "Medium / Red",
      sku: "SG-M-RED",
      quantity: 2,
      unitPriceCents: 4999,
      lineTotalCents: 9998,
    },
  ],
  subtotalCents: 9998,
  discountCents: 0,
  shippingCents: 1500,
  taxCents: 1300,
  totalCents: 12798,
  shippingAddress: {
    firstName: "Jordan",
    lastName: "Example",
    line1: "123 Test Street",
    line2: null,
    city: "Toronto",
    province: "ON",
    postalCode: "M4B 1B3",
    country: "CA",
  },
};

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<script>&"'</script>`)).toBe(
      "&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;",
    );
  });
});

describe("renderOrderConfirmationEmail", () => {
  it("includes the order number, items, and correctly-formatted CAD totals", () => {
    const rendered = renderOrderConfirmationEmail(baseOrder);
    expect(rendered.subject).toContain(baseOrder.orderNumber);
    expect(rendered.html).toContain(baseOrder.orderNumber);
    expect(rendered.text).toContain(baseOrder.orderNumber);

    expect(rendered.html).toContain("Sparring Gloves");
    expect(rendered.html).toContain("SG-M-RED");
    expect(rendered.text).toContain("Sparring Gloves");

    const expectedTotal = formatCents(baseOrder.totalCents, "CAD");
    expect(rendered.html).toContain(expectedTotal);
    expect(rendered.text).toContain(expectedTotal);
    const expectedUnit = formatCents(baseOrder.items[0]!.unitPriceCents, "CAD");
    expect(rendered.html).toContain(expectedUnit);
  });

  it("never invents a delivery date, tracking number, or policy text", () => {
    const rendered = renderOrderConfirmationEmail(baseOrder);
    const combined = `${rendered.html} ${rendered.text}`.toLowerCase();
    expect(combined).not.toMatch(/track/);
    expect(combined).not.toMatch(/deliver by|arrives?\s+(on|by|in)/);
    expect(combined).not.toMatch(/return policy|refund policy/);
  });

  it("escapes a malicious product name in HTML but keeps it literal in plain text", () => {
    const malicious: OrderEmailSnapshot = {
      ...baseOrder,
      items: [
        {
          ...baseOrder.items[0]!,
          productName: `<script>alert('xss')</script>`,
        },
      ],
    };
    const rendered = renderOrderConfirmationEmail(malicious);
    expect(rendered.html).not.toContain("<script>alert('xss')</script>");
    expect(rendered.html).toContain("&lt;script&gt;");
    // Plain text is never parsed as markup — no escaping needed or wanted there.
    expect(rendered.text).toContain(`<script>alert('xss')</script>`);
  });

  it("escapes a malicious shipping address field", () => {
    const malicious: OrderEmailSnapshot = {
      ...baseOrder,
      shippingAddress: { ...baseOrder.shippingAddress!, city: `<img src=x onerror=alert(1)>` },
    };
    const rendered = renderOrderConfirmationEmail(malicious);
    expect(rendered.html).not.toContain("<img src=x onerror=alert(1)>");
    expect(rendered.html).toContain("&lt;img");
  });

  it("omits the shipping-address section entirely when there is none", () => {
    const noAddress: OrderEmailSnapshot = { ...baseOrder, shippingAddress: null };
    const rendered = renderOrderConfirmationEmail(noAddress);
    expect(rendered.html).not.toContain("Shipping to");
    expect(rendered.text).not.toContain("Shipping to:");
  });

  it("omits the discount row when there is no discount, includes it when there is", () => {
    const noDiscount = renderOrderConfirmationEmail(baseOrder);
    expect(noDiscount.text).not.toContain("Discount");

    const withDiscount = renderOrderConfirmationEmail({ ...baseOrder, discountCents: 500 });
    expect(withDiscount.text).toContain("Discount");
    expect(withDiscount.text).toContain(formatCents(500, "CAD"));
  });
});

describe("renderShippingNotificationEmail", () => {
  it("says the order has shipped, without inventing a tracking number or delivery date", () => {
    const rendered = renderShippingNotificationEmail(baseOrder);
    expect(rendered.subject.toLowerCase()).toContain("shipped");
    expect(rendered.text.toLowerCase()).toContain("shipped");
    const combined = `${rendered.html} ${rendered.text}`.toLowerCase();
    expect(combined).not.toMatch(/track/);
    expect(combined).not.toMatch(/deliver by|arrives?\s+(on|by|in)/);
  });

  it("also escapes malicious content", () => {
    const malicious: OrderEmailSnapshot = {
      ...baseOrder,
      items: [{ ...baseOrder.items[0]!, sku: `"><script>alert(1)</script>` }],
    };
    const rendered = renderShippingNotificationEmail(malicious);
    expect(rendered.html).not.toContain(`"><script>alert(1)</script>`);
  });
});
