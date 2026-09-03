import { Prisma, type PrismaClient, type UserRole, type UserStatus } from "@prisma/client";

import { prisma } from "@/server/db/client";

/**
 * User persistence. The only module allowed to read `passwordHash`, and it does
 * so through exactly one function (`findCredentialsByEmail`). Every other read
 * uses `safeUserSelect`, which omits the hash, so it is structurally impossible
 * to leak it through a normal query.
 */

export const safeUserSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  role: true,
  status: true,
  emailVerifiedAt: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export type SafeUser = Prisma.UserGetPayload<{ select: typeof safeUserSelect }>;

type Db = Pick<PrismaClient, "user">;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserById(id: string, db: Db = prisma): Promise<SafeUser | null> {
  return db.user.findUnique({ where: { id }, select: safeUserSelect });
}

export async function findUserByEmail(email: string, db: Db = prisma): Promise<SafeUser | null> {
  return db.user.findUnique({
    where: { email: normalizeEmail(email) },
    select: safeUserSelect,
  });
}

/**
 * Includes `passwordHash`. Call ONLY from the credentials authenticator and the
 * self-service password-change flow. Never return the result of this function
 * from a route handler or service response.
 */
export async function findCredentialsByEmail(
  email: string,
  db: Db = prisma,
): Promise<(SafeUser & { passwordHash: string | null }) | null> {
  return db.user.findUnique({
    where: { email: normalizeEmail(email) },
    select: { ...safeUserSelect, passwordHash: true },
  });
}

/** Includes `passwordHash`. Same caller restrictions as `findCredentialsByEmail`. */
export async function findCredentialsById(
  id: string,
  db: Db = prisma,
): Promise<(SafeUser & { passwordHash: string | null }) | null> {
  return db.user.findUnique({
    where: { id },
    select: { ...safeUserSelect, passwordHash: true },
  });
}

export interface CreateUserInput {
  email: string;
  passwordHash?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  role?: UserRole;
  status?: UserStatus;
  emailVerifiedAt?: Date | null;
}

export async function createUser(input: CreateUserInput, db: Db = prisma): Promise<SafeUser> {
  return db.user.create({
    data: {
      email: normalizeEmail(input.email),
      passwordHash: input.passwordHash ?? null,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      role: input.role,
      status: input.status,
      emailVerifiedAt: input.emailVerifiedAt ?? null,
    },
    select: safeUserSelect,
  });
}

export async function setUserRole(id: string, role: UserRole, db: Db = prisma): Promise<SafeUser> {
  return db.user.update({ where: { id }, data: { role }, select: safeUserSelect });
}

export async function setUserStatus(
  id: string,
  status: UserStatus,
  db: Db = prisma,
): Promise<SafeUser> {
  return db.user.update({ where: { id }, data: { status }, select: safeUserSelect });
}

export async function setUserPasswordHash(
  id: string,
  passwordHash: string,
  db: Db = prisma,
): Promise<void> {
  await db.user.update({ where: { id }, data: { passwordHash } });
}

export async function markEmailVerified(id: string, db: Db = prisma): Promise<void> {
  await db.user.update({ where: { id }, data: { emailVerifiedAt: new Date() } });
}

export async function recordSuccessfulLogin(id: string, db: Db = prisma): Promise<void> {
  await db.user.update({ where: { id }, data: { lastLoginAt: new Date() } });
}

export interface ListUsersOptions {
  skip?: number;
  take?: number;
  role?: UserRole;
  status?: UserStatus;
  search?: string;
}

export async function listUsers(
  options: ListUsersOptions = {},
  db: Db = prisma,
): Promise<{ users: SafeUser[]; total: number }> {
  const take = Math.min(Math.max(options.take ?? 50, 1), 200);
  const skip = Math.max(options.skip ?? 0, 0);

  const where: Prisma.UserWhereInput = {
    ...(options.role ? { role: options.role } : {}),
    ...(options.status ? { status: options.status } : {}),
    ...(options.search
      ? {
          OR: [
            { email: { contains: normalizeEmail(options.search) } },
            { firstName: { contains: options.search, mode: "insensitive" } },
            { lastName: { contains: options.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [users, total] = await Promise.all([
    db.user.findMany({ where, select: safeUserSelect, orderBy: { createdAt: "desc" }, skip, take }),
    db.user.count({ where }),
  ]);
  return { users, total };
}
