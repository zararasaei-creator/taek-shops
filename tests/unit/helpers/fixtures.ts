import { UserRole, UserStatus } from "@prisma/client";

import type { SafeUser } from "@/server/db/users-repo";

let counter = 0;

export function makeUser(overrides: Partial<SafeUser> = {}): SafeUser {
  counter += 1;
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: `user_${counter}`,
    email: `user${counter}@example.com`,
    firstName: "Test",
    lastName: "User",
    phone: null,
    role: UserRole.CUSTOMER,
    status: UserStatus.ACTIVE,
    emailVerifiedAt: null,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makeCredentialsUser(
  overrides: Partial<SafeUser & { passwordHash: string | null }> = {},
): SafeUser & { passwordHash: string | null } {
  return { ...makeUser(overrides), passwordHash: null, ...overrides };
}
