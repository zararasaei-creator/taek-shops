// @vitest-environment node
import { UserRole } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { ForbiddenError, UnauthenticatedError } from "@/server/auth/errors";
import {
  assertCanAssignRole,
  canAssignRole,
  hasAnyRole,
  hasPermission,
  hasRole,
  isAdmin,
  isManager,
  isStaff,
  permissionsForRole,
  requireAnyRole,
  requirePermission,
  requireRole,
  requireUser,
  type AuthUser,
} from "@/server/auth/authorization";
import { PrivilegeEscalationError } from "@/server/auth/errors";

const customer: AuthUser = { id: "c", role: UserRole.CUSTOMER };
const staff: AuthUser = { id: "s", role: UserRole.STAFF };
const manager: AuthUser = { id: "m", role: UserRole.MANAGER };
const admin: AuthUser = { id: "a", role: UserRole.ADMIN };

describe("role hierarchy", () => {
  it("orders CUSTOMER < STAFF < MANAGER < ADMIN", () => {
    expect(hasRole(customer, UserRole.STAFF)).toBe(false);
    expect(hasRole(staff, UserRole.STAFF)).toBe(true);
    expect(hasRole(manager, UserRole.STAFF)).toBe(true);
    expect(hasRole(admin, UserRole.MANAGER)).toBe(true);
    expect(hasRole(manager, UserRole.ADMIN)).toBe(false);
  });

  it("hasAnyRole is exact membership", () => {
    expect(hasAnyRole(manager, [UserRole.STAFF, UserRole.ADMIN])).toBe(false);
    expect(hasAnyRole(manager, [UserRole.MANAGER])).toBe(true);
  });

  it("convenience predicates", () => {
    expect(isStaff(staff)).toBe(true);
    expect(isManager(staff)).toBe(false);
    expect(isManager(manager)).toBe(true);
    expect(isAdmin(manager)).toBe(false);
    expect(isAdmin(admin)).toBe(true);
    expect(isStaff(null)).toBe(false);
  });
});

describe("permissions", () => {
  it("inherit upward through the hierarchy", () => {
    expect([...permissionsForRole(UserRole.CUSTOMER)]).toEqual([]);
    expect(permissionsForRole(UserRole.STAFF).has("catalog.read")).toBe(true);
    expect(permissionsForRole(UserRole.MANAGER).has("catalog.read")).toBe(true);
    expect(permissionsForRole(UserRole.MANAGER).has("catalog.write")).toBe(true);
    expect(permissionsForRole(UserRole.ADMIN).has("catalog.write")).toBe(true);
  });

  it("only ADMIN holds user.role.write / user.status.write / audit.read", () => {
    for (const role of [UserRole.CUSTOMER, UserRole.STAFF, UserRole.MANAGER]) {
      expect(permissionsForRole(role).has("user.role.write")).toBe(false);
      expect(permissionsForRole(role).has("user.status.write")).toBe(false);
      expect(permissionsForRole(role).has("audit.read")).toBe(false);
    }
    expect(permissionsForRole(UserRole.ADMIN).has("user.role.write")).toBe(true);
    expect(hasPermission(admin, "audit.read")).toBe(true);
  });

  it("user.read is MANAGER and above", () => {
    expect(hasPermission(staff, "user.read")).toBe(false);
    expect(hasPermission(manager, "user.read")).toBe(true);
    expect(hasPermission(admin, "user.read")).toBe(true);
  });
});

describe("guards", () => {
  it("requireUser throws UnauthenticatedError for null", () => {
    expect(() => requireUser(null)).toThrow(UnauthenticatedError);
    expect(requireUser(staff)).toBe(staff);
  });

  it("requireRole enforces the minimum and reports 403 for the shortfall", () => {
    expect(() => requireRole(customer, UserRole.STAFF)).toThrow(ForbiddenError);
    expect(requireRole(admin, UserRole.STAFF)).toBe(admin);
  });

  it("requireAnyRole enforces exact membership", () => {
    expect(() => requireAnyRole(manager, [UserRole.STAFF, UserRole.ADMIN])).toThrow(ForbiddenError);
    expect(requireAnyRole(admin, [UserRole.ADMIN])).toBe(admin);
  });

  it("requirePermission enforces the capability", () => {
    expect(() => requirePermission(manager, "user.role.write")).toThrow(ForbiddenError);
    expect(() => requirePermission(null, "user.read")).toThrow(UnauthenticatedError);
    expect(requirePermission(admin, "user.role.write")).toBe(admin);
  });
});

describe("role-assignment escalation rule", () => {
  it("ADMIN may assign any role including ADMIN", () => {
    expect(canAssignRole(UserRole.ADMIN, UserRole.ADMIN)).toBe(true);
    expect(canAssignRole(UserRole.ADMIN, UserRole.CUSTOMER)).toBe(true);
  });

  it("a non-admin may only assign roles strictly below their own", () => {
    expect(canAssignRole(UserRole.MANAGER, UserRole.STAFF)).toBe(true);
    expect(canAssignRole(UserRole.MANAGER, UserRole.MANAGER)).toBe(false);
    expect(canAssignRole(UserRole.MANAGER, UserRole.ADMIN)).toBe(false);
    expect(canAssignRole(UserRole.STAFF, UserRole.STAFF)).toBe(false);
  });

  it("assertCanAssignRole throws PrivilegeEscalationError", () => {
    expect(() => assertCanAssignRole(manager, UserRole.ADMIN)).toThrow(PrivilegeEscalationError);
    expect(() => assertCanAssignRole(admin, UserRole.ADMIN)).not.toThrow();
  });
});
