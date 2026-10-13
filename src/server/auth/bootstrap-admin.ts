import { Prisma, UserRole, UserStatus, type PrismaClient } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { recordAudit } from "@/server/audit/audit-service";
import { AUDIT_ACTIONS } from "@/server/audit/actions";
import { createUser, type SafeUser } from "@/server/db/users-repo";
import { hashPassword } from "@/server/auth/password";
import { emailSchema } from "@/lib/validation/auth";

/**
 * First-ADMIN bootstrap for a freshly migrated production database — the core of
 * `scripts/bootstrap-admin.ts` (operator-only CLI; there is deliberately NO HTTP
 * endpoint, and the web app never calls this).
 *
 * Why it exists: a migrated database has no users, and the only other way to
 * create one (`prisma db seed`) also writes sample tax/shipping rows. This writes
 * exactly ONE `User` row (+ one audit row) and nothing else — no products, tax
 * rates, shipping methods, orders or other business data, and it sends no email.
 *
 * Guarantees:
 *  - **Only one first ADMIN, even under concurrency.** The check-and-insert runs
 *    in one transaction behind a Postgres advisory lock, so two simultaneous
 *    bootstraps (same or different emails) serialize: the second sees the first's
 *    ADMIN and is refused. The unique `User.email` constraint is a second,
 *    independent backstop for the same-email race.
 *  - **Refuses if any ADMIN already exists** (any status — a disabled admin still
 *    counts; recovering from that is an explicit operator decision, not something
 *    this command does).
 *  - **Never promotes or overwrites.** If the email already belongs to any user
 *    (customer, staff, even an ADMIN), it refuses without touching that row.
 *  - **Reuses existing primitives only:** the email schema/normalization, the
 *    Argon2id `hashPassword` with the existing password policy (so a weak or
 *    personal-info password is refused), `createUser`, and `recordAudit`.
 *  - **Login works, verification is not faked:** the account is created `ACTIVE`
 *    (login requires `ACTIVE`; `adminCreateUser`'s `INVITED` status cannot sign in)
 *    with `emailVerifiedAt = null`.
 *  - **Secrets stay out:** the password is only ever hashed here; the audit row
 *    carries role/status/method, never the password or hash.
 */

type Db = PrismaClient;

/** Arbitrary constant namespace for the advisory lock; only needs to be stable. */
const BOOTSTRAP_LOCK_KEY = 7_419_271_001;

export type BootstrapRefusalCode = "admin_exists" | "email_in_use" | "invalid_email" | "usage";

/** An expected, operator-facing refusal (exit code 2 in the CLI) — not a crash. */
export class BootstrapRefusedError extends Error {
  readonly code: BootstrapRefusalCode;
  constructor(code: BootstrapRefusalCode, message: string) {
    super(message);
    this.name = "BootstrapRefusedError";
    this.code = code;
  }
}

export interface BootstrapInput {
  email: string;
  password: string;
  firstName?: string | null;
  lastName?: string | null;
}

/** Test-only seam (never set outside tests): lets a test hold one attempt open between its checks and its insert, deterministically proving the lock. */
export interface BootstrapHooks {
  afterChecks?: () => Promise<void>;
}

export async function bootstrapFirstAdmin(
  input: BootstrapInput,
  db: Db = prisma,
  hooks: BootstrapHooks = {},
): Promise<SafeUser> {
  const parsedEmail = emailSchema.safeParse(input.email);
  if (!parsedEmail.success) {
    throw new BootstrapRefusedError("invalid_email", "That is not a valid email address.");
  }
  const email = parsedEmail.data;
  const firstName = input.firstName?.trim() || null;
  const lastName = input.lastName?.trim() || null;

  // Throws WeakPasswordError (reasons only — never the password) under the existing
  // policy. Hashed BEFORE taking the lock so the lock is held only for the short
  // check-and-insert, not for the CPU-heavy Argon2id work.
  const passwordHash = await hashPassword(input.password, { email, firstName, lastName });

  let admin: SafeUser;
  try {
    admin = await db.$transaction(
      async (tx) => {
        // Serialize concurrent bootstraps. (`$executeRaw`, not `$queryRaw`: the
        // function returns `void`, which Prisma cannot deserialize.)
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`);

        if ((await tx.user.count({ where: { role: UserRole.ADMIN } })) > 0) {
          throw new BootstrapRefusedError(
            "admin_exists",
            "An ADMIN account already exists. Bootstrap only creates the first one.",
          );
        }
        if (await tx.user.findUnique({ where: { email }, select: { id: true } })) {
          throw new BootstrapRefusedError(
            "email_in_use",
            "That email already belongs to an existing account. It was not changed or promoted.",
          );
        }

        await hooks.afterChecks?.();

        return createUser(
          {
            email,
            passwordHash,
            firstName,
            lastName,
            role: UserRole.ADMIN,
            status: UserStatus.ACTIVE, // login requires ACTIVE
            emailVerifiedAt: null, // deliberately NOT marked verified
          },
          tx,
        );
      },
      { timeout: 20_000, maxWait: 20_000 },
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // Same-email race that slipped past the read (the unique index decided).
      throw new BootstrapRefusedError(
        "email_in_use",
        "That email already belongs to an existing account. It was not changed or promoted.",
      );
    }
    throw error;
  }

  await recordAudit(
    {
      action: AUDIT_ACTIONS.ADMIN_BOOTSTRAPPED,
      actorUserId: null, // no authenticated actor exists yet — this is the first user
      entityType: "User",
      entityId: admin.id,
      metadata: { role: admin.role, status: admin.status, emailVerified: false, via: "cli" },
    },
    db,
  );
  return admin;
}
