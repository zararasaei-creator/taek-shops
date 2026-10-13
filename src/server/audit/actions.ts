/**
 * Audit action constants. Dotted `domain.subject.event` strings, stored as plain
 * text in `AuditLog.action` (not a DB enum) so new business events can be added
 * without a migration. Keep this list the single source of truth.
 */
export const AUDIT_ACTIONS = {
  LOGIN_SUCCEEDED: "auth.login.succeeded",
  LOGIN_FAILED: "auth.login.failed",
  LOGOUT: "auth.logout",
  SESSION_REVOKED: "auth.session.revoked",
  PASSWORD_CHANGED: "auth.password.changed",
  PASSWORD_RESET_REQUESTED: "auth.password.reset_requested",
  PASSWORD_RESET_COMPLETED: "auth.password.reset_completed",
  EMAIL_VERIFICATION_REQUESTED: "auth.email.verification_requested",
  EMAIL_VERIFIED: "auth.email.verified",
  USER_CREATED: "user.created",
  USER_REGISTERED: "user.registered",
  ADMIN_BOOTSTRAPPED: "auth.admin.bootstrapped",
  USER_REGISTRATION_DUPLICATE: "user.registration.duplicate",
  EMAIL_VERIFICATION_SEND_FAILED: "auth.email.verification_send_failed",
  USER_ROLE_CHANGED: "user.role.changed",
  USER_STATUS_CHANGED: "user.status.changed",

  // Catalogue (Phase 4)
  BRAND_CREATED: "catalog.brand.created",
  BRAND_UPDATED: "catalog.brand.updated",
  BRAND_ARCHIVED: "catalog.brand.archived",
  CATEGORY_CREATED: "catalog.category.created",
  CATEGORY_UPDATED: "catalog.category.updated",
  CATEGORY_ARCHIVED: "catalog.category.archived",
  PRODUCT_CREATED: "catalog.product.created",
  PRODUCT_UPDATED: "catalog.product.updated",
  PRODUCT_STATUS_CHANGED: "catalog.product.status_changed",
  PRODUCT_OPTIONS_CHANGED: "catalog.product.options_changed",
  PRODUCT_OPTION_EXTENDED: "catalog.product.option_extended",
  VARIANT_CREATED: "catalog.variant.created",
  VARIANT_UPDATED: "catalog.variant.updated",
  VARIANT_PRICE_CHANGED: "catalog.variant.price_changed",
  VARIANT_ARCHIVED: "catalog.variant.archived",
  VARIANT_MATRIX_GENERATED: "catalog.variant.matrix_generated",
  PRODUCT_IMAGE_ADDED: "catalog.image.added",
  PRODUCT_IMAGE_UPDATED: "catalog.image.updated",
  PRODUCT_IMAGE_REMOVED: "catalog.image.removed",
  PRODUCT_IMAGE_REORDERED: "catalog.image.reordered",
  PRODUCT_IMAGE_UPLOAD_CREATED: "catalog.image.upload_created",
  PRODUCT_IMAGE_UPLOAD_REJECTED: "catalog.image.upload_rejected",

  // Inventory (Phase 4)
  INVENTORY_ADJUSTED: "inventory.adjusted",
  INVENTORY_RECEIVED: "inventory.received",
  INVENTORY_RESERVED: "inventory.reserved",
  INVENTORY_RELEASED: "inventory.released",
  INVENTORY_COMMITTED: "inventory.committed",
  INVENTORY_RESTOCKED: "inventory.restocked",

  // Import (Phase 4)
  IMPORT_PREVIEWED: "import.product.previewed",
  IMPORT_COMMITTED: "import.product.committed",
  IMPORT_CANCELLED: "import.product.cancelled",

  // Orders (Phase 5 — inventory lifecycle wiring)
  ORDER_STATUS_CHANGED: "order.status.changed",

  // Order management (Phase 8)
  ORDER_FULFILLMENT_STATUS_CHANGED: "order.fulfillment_status.changed",

  // Checkout (Phase 6)
  ORDER_PLACED: "order.placed",

  // Payments (Phase 7 — Stripe)
  PAYMENT_INTENT_CREATED: "payment.intent.created",
  PAYMENT_SUCCEEDED: "payment.succeeded",
  PAYMENT_FAILED: "payment.failed",
  PAYMENT_AMOUNT_MISMATCH: "payment.amount_mismatch",
  PAYMENT_LATE_SUCCESS: "payment.late_success",
  PAYMENT_WEBHOOK_UNHANDLED: "payment.webhook.unhandled",
  PAYMENT_WEBHOOK_STALE: "payment.webhook.stale",

  // Abandoned-checkout reservation recovery (launch-prep milestone)
  ORDER_EXPIRED: "order.expired",

  // Admin cancellation of a PENDING order — provider-aware (see order-cancellation.ts)
  ORDER_CANCEL_PRESERVED: "order.cancel.preserved",

  // Tax & shipping configuration (Phase 11)
  TAX_REGION_CREATED: "config.tax_region.created",
  TAX_REGION_UPDATED: "config.tax_region.updated",
  TAX_RATE_CREATED: "config.tax_rate.created",
  TAX_RATE_UPDATED: "config.tax_rate.updated",
  SHIPPING_ZONE_CREATED: "config.shipping_zone.created",
  SHIPPING_ZONE_UPDATED: "config.shipping_zone.updated",
  SHIPPING_ZONE_REGION_ADDED: "config.shipping_zone_region.added",
  SHIPPING_ZONE_REGION_REMOVED: "config.shipping_zone_region.removed",
  SHIPPING_METHOD_CREATED: "config.shipping_method.created",
  SHIPPING_METHOD_UPDATED: "config.shipping_method.updated",

  // Refunds (Phase 8)
  REFUND_REQUESTED: "payment.refund.requested",
  REFUND_SUCCEEDED: "payment.refund.succeeded",
  REFUND_FAILED: "payment.refund.failed",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
