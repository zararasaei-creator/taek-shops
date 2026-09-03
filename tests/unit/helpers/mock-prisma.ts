import type { PrismaClient } from "@prisma/client";
import { mockDeep, type DeepMockProxy } from "vitest-mock-extended";

/** A deeply-mocked PrismaClient for service-layer unit tests (no real database). */
export type MockPrisma = DeepMockProxy<PrismaClient>;

export function createMockPrisma(): MockPrisma {
  const db = mockDeep<PrismaClient>();
  // Run interactive transactions inline against the same mock; pass arrays through.
  looseMock(db.$transaction).mockImplementation((arg: unknown) =>
    typeof arg === "function"
      ? (arg as (tx: MockPrisma) => unknown)(db)
      : Promise.all(arg as unknown[]),
  );
  return db;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Loosely-typed access to a Prisma delegate mock's `mockImplementation`, for
 * tests that need to branch on the `where` argument. The strict Prisma method
 * overloads make a typed implementation impractical in a mock.
 */
export function looseMock(method: unknown): {
  mockImplementation: (impl: (arg: any) => unknown) => void;
} {
  return method as { mockImplementation: (impl: (arg: any) => unknown) => void };
}
