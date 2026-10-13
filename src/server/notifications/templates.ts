/**
 * Order-email templates (Phase 8): escaped HTML + plain text, built only
 * from an order snapshot's own recorded fields (item names/SKUs/quantities/
 * prices at purchase time, address, totals). Never invents a delivery date,
 * a tracking number/link, or policy text — none of that data exists in this
 * schema, and a template must not imply information the system doesn't
 * actually have.
 *
 * Relative imports only (see `order-mailer.ts`'s module comment for why).
 */

import { formatCents, type CurrencyCode } from "../domain/money.ts";

export interface OrderEmailItemSnapshot {
  productName: string;
  variantName: string | null;
  sku: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface OrderEmailAddressSnapshot {
  firstName: string;
  lastName: string;
  line1: string;
  line2: string | null;
  city: string;
  province: string;
  postalCode: string;
  country: string;
}

export interface OrderEmailSnapshot {
  orderNumber: string;
  currency: CurrencyCode;
  items: OrderEmailItemSnapshot[];
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  /** Null when the order has no recorded shipping address. */
  shippingAddress: OrderEmailAddressSnapshot | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** Minimal, dependency-free HTML escaping — the only templating this needs. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function itemLabel(item: OrderEmailItemSnapshot): string {
  return item.variantName ? `${item.productName} — ${item.variantName}` : item.productName;
}

function itemsHtml(items: OrderEmailItemSnapshot[], currency: CurrencyCode): string {
  const rows = items
    .map(
      (item) => `
      <tr>
        <td style="padding:4px 8px;">${escapeHtml(itemLabel(item))}<br><span style="color:#71717a;font-size:12px;">${escapeHtml(item.sku)}</span></td>
        <td style="padding:4px 8px;text-align:right;">${item.quantity}</td>
        <td style="padding:4px 8px;text-align:right;">${escapeHtml(formatCents(item.unitPriceCents, currency))}</td>
        <td style="padding:4px 8px;text-align:right;">${escapeHtml(formatCents(item.lineTotalCents, currency))}</td>
      </tr>`,
    )
    .join("");
  return `<table style="width:100%;border-collapse:collapse;">
    <thead>
      <tr style="text-align:right;color:#71717a;font-size:12px;">
        <th style="text-align:left;padding:4px 8px;">Item</th>
        <th style="padding:4px 8px;">Qty</th>
        <th style="padding:4px 8px;">Unit price</th>
        <th style="padding:4px 8px;">Line total</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function itemsText(items: OrderEmailItemSnapshot[], currency: CurrencyCode): string {
  return items
    .map(
      (item) =>
        `  - ${itemLabel(item)} (${item.sku}) x${item.quantity} @ ${formatCents(item.unitPriceCents, currency)} = ${formatCents(item.lineTotalCents, currency)}`,
    )
    .join("\n");
}

function totalsHtml(order: OrderEmailSnapshot): string {
  const rows: [string, number][] = [
    ["Subtotal", order.subtotalCents],
    ...(order.discountCents > 0
      ? ([["Discount", -order.discountCents]] as [string, number][])
      : []),
    ["Shipping", order.shippingCents],
    ["Tax", order.taxCents],
  ];
  const lines = rows
    .map(
      ([label, cents]) =>
        `<tr><td style="padding:2px 8px;color:#71717a;">${escapeHtml(label)}</td><td style="padding:2px 8px;text-align:right;">${escapeHtml(formatCents(cents, order.currency))}</td></tr>`,
    )
    .join("");
  return `<table style="width:100%;border-collapse:collapse;margin-top:8px;">
    ${lines}
    <tr><td style="padding:4px 8px;font-weight:600;">Total</td><td style="padding:4px 8px;text-align:right;font-weight:600;">${escapeHtml(formatCents(order.totalCents, order.currency))}</td></tr>
  </table>`;
}

function totalsText(order: OrderEmailSnapshot): string {
  const lines = [
    `  Subtotal: ${formatCents(order.subtotalCents, order.currency)}`,
    ...(order.discountCents > 0
      ? [`  Discount: -${formatCents(order.discountCents, order.currency)}`]
      : []),
    `  Shipping: ${formatCents(order.shippingCents, order.currency)}`,
    `  Tax: ${formatCents(order.taxCents, order.currency)}`,
    `  Total: ${formatCents(order.totalCents, order.currency)}`,
  ];
  return lines.join("\n");
}

function addressHtml(address: OrderEmailAddressSnapshot): string {
  return `<p>
    ${escapeHtml(address.firstName)} ${escapeHtml(address.lastName)}<br>
    ${escapeHtml(address.line1)}${address.line2 ? `<br>${escapeHtml(address.line2)}` : ""}<br>
    ${escapeHtml(address.city)}, ${escapeHtml(address.province)} ${escapeHtml(address.postalCode)}<br>
    ${escapeHtml(address.country)}
  </p>`;
}

function addressText(address: OrderEmailAddressSnapshot): string {
  return [
    `  ${address.firstName} ${address.lastName}`,
    `  ${address.line1}`,
    ...(address.line2 ? [`  ${address.line2}`] : []),
    `  ${address.city}, ${address.province} ${address.postalCode}`,
    `  ${address.country}`,
  ].join("\n");
}

export function renderOrderConfirmationEmail(order: OrderEmailSnapshot): RenderedEmail {
  const subject = `Order ${order.orderNumber} confirmed`;
  const html = `<div>
    <h1 style="font-size:18px;">Thanks for your order, ${escapeHtml(order.orderNumber)}!</h1>
    <p>We've received your payment and your order is being prepared.</p>
    ${itemsHtml(order.items, order.currency)}
    ${totalsHtml(order)}
    ${order.shippingAddress ? `<h2 style="font-size:14px;">Shipping to</h2>${addressHtml(order.shippingAddress)}` : ""}
  </div>`;
  const text = [
    `Thanks for your order, ${order.orderNumber}!`,
    "",
    "We've received your payment and your order is being prepared.",
    "",
    "Items:",
    itemsText(order.items, order.currency),
    "",
    totalsText(order),
    ...(order.shippingAddress ? ["", "Shipping to:", addressText(order.shippingAddress)] : []),
  ].join("\n");
  return { subject, html, text };
}

export function renderShippingNotificationEmail(order: OrderEmailSnapshot): RenderedEmail {
  const subject = `Order ${order.orderNumber} has shipped`;
  const html = `<div>
    <h1 style="font-size:18px;">Your order ${escapeHtml(order.orderNumber)} has shipped</h1>
    ${itemsHtml(order.items, order.currency)}
    ${totalsHtml(order)}
    ${order.shippingAddress ? `<h2 style="font-size:14px;">Shipping to</h2>${addressHtml(order.shippingAddress)}` : ""}
  </div>`;
  const text = [
    `Your order ${order.orderNumber} has shipped.`,
    "",
    "Items:",
    itemsText(order.items, order.currency),
    "",
    totalsText(order),
    ...(order.shippingAddress ? ["", "Shipping to:", addressText(order.shippingAddress)] : []),
  ].join("\n");
  return { subject, html, text };
}
