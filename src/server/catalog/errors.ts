/**
 * Typed catalogue errors. Like `AuthError`, each carries a machine `code`, an
 * HTTP `status`, and a user-safe `publicMessage`. Route handlers / actions map
 * these to responses via `src/lib/http/api-response.ts`.
 */

export type CatalogErrorCode =
  | "not_found"
  | "conflict"
  | "validation"
  | "invalid_state_transition"
  | "referential_integrity"
  | "inventory_rule";

export class CatalogError extends Error {
  readonly code: CatalogErrorCode;
  readonly status: number;
  readonly publicMessage: string;
  readonly details?: unknown;

  constructor(
    code: CatalogErrorCode,
    status: number,
    publicMessage: string,
    options?: { internalMessage?: string; details?: unknown },
  ) {
    super(options?.internalMessage ?? publicMessage);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
    this.details = options?.details;
  }
}

export class NotFoundError extends CatalogError {
  constructor(entity: string, identifier?: string) {
    super("not_found", 404, `${entity} not found.`, {
      internalMessage: `${entity} not found${identifier ? ` (${identifier})` : ""}`,
    });
  }
}

export class ConflictError extends CatalogError {
  constructor(publicMessage: string, internalMessage?: string) {
    super("conflict", 409, publicMessage, { internalMessage });
  }
}

export class CatalogValidationError extends CatalogError {
  constructor(publicMessage: string, details?: unknown) {
    super("validation", 422, publicMessage, { details });
  }
}

export class InvalidStateTransitionError extends CatalogError {
  constructor(publicMessage: string, internalMessage?: string) {
    super("invalid_state_transition", 409, publicMessage, { internalMessage });
  }
}

export class ReferentialIntegrityError extends CatalogError {
  constructor(publicMessage: string, internalMessage?: string) {
    super("referential_integrity", 409, publicMessage, { internalMessage });
  }
}

export class InventoryRuleError extends CatalogError {
  constructor(publicMessage: string, internalMessage?: string) {
    super("inventory_rule", 409, publicMessage, { internalMessage });
  }
}

export function isCatalogError(error: unknown): error is CatalogError {
  return error instanceof CatalogError;
}
