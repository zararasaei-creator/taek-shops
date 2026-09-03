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
  VARIANT_CREATED: "catalog.variant.created",
  VARIANT_UPDATED: "catalog.variant.updated",
  VARIANT_PRICE_CHANGED: "catalog.variant.price_changed",
  VARIANT_ARCHIVED: "catalog.variant.archived",
  PRODUCT_IMAGE_ADDED: "catalog.image.added",
  PRODUCT_IMAGE_UPDATED: "catalog.image.updated",
  PRODUCT_IMAGE_REMOVED: "catalog.image.removed",

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

  // Checkout (Phase 6)
  ORDER_PLACED: "order.placed",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
