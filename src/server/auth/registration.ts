import { Prisma, UserRole, UserStatus, type PrismaClient } from "@prisma/client";

import { prisma } from "@/server/db/client";
import { recordAudit } from "@/server/audit/audit-service";
import { AUDIT_ACTIONS } from "@/server/audit/actions";
import { createUser, normalizeEmail, type SafeUser } from "@/server/db/users-repo";
import { EmailSendFailedError, RateLimitedError, isAuthError } from "@/server/auth/errors";
import { requireUser } from "@/server/auth/authorization";
import { hashPassword } from "@/server/auth/password";
import {
  enforceRateLimit,
  rateLimiter as defaultLimiter,
  type RateLimiter,
} from "@/server/auth/rate-limit";
import { requestEmailVerification, type VerificationDeps } from "@/server/auth/verification";

/**
 * Customer self-registration and verification resend.
 *
 * **What the server controls, never the client.** `registerCustomer` accepts
 * exactly `firstName`, `lastName`, `email`, `password` (+ request metadata).
 * Role (`CUSTOMER`), account status (`ACTIVE`) and verification state
 * (`emailVerifiedAt: null`) are constants in this file — there is no code path
 * from request input to any of them, so a tampered body (`role`, `status`,
 * `emailVerifiedAt`, `permissions`, …) cannot influence them even if a route
 * forwarded it (the route's schema also strips unknown keys).
 *
 * **Account-status / login policy (smallest compatible).** Login requires
 * `status === ACTIVE` and never consults `emailVerifiedAt`, so a new customer is
 * created `ACTIVE` + unverified and can sign in immediately. Nothing in the app
 * is currently gated on verification (checkout is open to guests anyway), so an
 * unverified customer can: sign in, browse, check out, pay, see their own order
 * history, and request a new verification link. Verification is therefore
 * advisory today; gating anything on it is an explicit future decision. Staff
 * and admin access is by `role` only and is untouched by this module.
 *
 * **No account enumeration.** The caller always gets the same outcome whether
 * the email was new or taken. The password is hashed BEFORE the insert so the
 * two paths cost the same; the database's `User.email` unique constraint — not
 * a read-then-write check — decides duplicates, which is also what makes
 * concurrent registrations safe. A duplicate NEVER touches the existing
 * account (no password, role, name or status write) and sends no email.
 *
 * **Mail failure is recoverable.** The account is committed before any email
 * is attempted. If sending fails, the account stays, the failure is audited,
 * and the customer can sign in and use "resend" (`resendVerificationForUser`).
 * Nothing here ever claims the message reached an inbox — only that it was
 * requested.
 */

type Db = Pick<PrismaClient, "user" | "verificationToken" | "session" | "auditLog">;

export interface RegistrationInput {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface RegistrationDeps extends VerificationDeps {
  db?: Db;
  limiter?: RateLimiter;
}

/** What actually happened — for tests and audit only; routes must NOT expose it. */
export type RegistrationOutcome =
  | { created: true; verificationEmail: "requested" | "failed" }
  | { created: false };

export async function registerCustomer(
  input: RegistrationInput,
  deps: RegistrationDeps = {},
): Promise<RegistrationOutcome> {
  const db = deps.db ?? prisma;
  const limiter = deps.limiter ?? defaultLimiter;
  const email = normalizeEmail(input.email);

  for (const key of [`email:${email}`, `ip:${input.ipAddress ?? "unknown"}`]) {
    const result = await enforceRateLimit("registration", key, limiter);
    if (!result.allowed) throw new RateLimitedError(result.retryAfterSeconds);
  }

  // Throws WeakPasswordError (422) — about the password only, reveals nothing
  // about the email. Done before the insert on every path so timing matches.
  const passwordHash = await hashPassword(input.password, {
    email,
    firstName: input.firstName,
    lastName: input.lastName,
  });

  let user: SafeUser;
  try {
    user = await createUser(
      {
        email,
        passwordHash,
        firstName: input.firstName,
        lastName: input.lastName,
        // Server-controlled. Deliberately not parameters of this function.
        role: UserRole.CUSTOMER,
        status: UserStatus.ACTIVE,
        emailVerifiedAt: null,
      },
      db,
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // Already registered (or a concurrent registration won). Leave the
      // existing account completely alone and answer exactly as for success.
      await recordAudit(
        {
          action: AUDIT_ACTIONS.USER_REGISTRATION_DUPLICATE,
          metadata: { email },
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
        },
        db,
      );
      return { created: false };
    }
    throw error;
  }

  let verificationEmail: "requested" | "failed" = "requested";
  try {
    await requestEmailVerification(
      { email, ipAddress: input.ipAddress, userAgent: input.userAgent },
      deps,
    );
  } catch (error) {
    // The account is already committed and usable; the customer can resend
    // from their account page. Never log the token or the message.
    verificationEmail = "failed";
    console.warn(
      "[registration] verification email could not be requested for a new account (%s)",
      error instanceof Error ? error.name : "unknown error",
    );
  }

  await recordAudit(
    {
      action: AUDIT_ACTIONS.USER_REGISTERED,
      actorUserId: user.id,
      entityType: "User",
      entityId: user.id,
      metadata: { role: user.role, status: user.status, verificationEmail },
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
    db,
  );
  return { created: true, verificationEmail };
}

/**
 * Authenticated "resend verification". Uses the SESSION's user — the client
 * supplies no email — and the existing `requestEmailVerification` flow, whose
 * per-email and per-IP rate limits apply. Unlike the public flows this one
 * tells the truth about failure: the caller is signed in, so there is no
 * enumeration to protect, and a customer whose first email failed needs to
 * know to retry.
 */
export async function resendVerificationForUser(
  user: SafeUser | null | undefined,
  meta: { ipAddress?: string | null; userAgent?: string | null } = {},
  deps: VerificationDeps = {},
): Promise<"requested" | "already_verified"> {
  const authed = requireUser(user);
  if (authed.emailVerifiedAt) return "already_verified";

  try {
    await requestEmailVerification({ email: authed.email, ...meta }, deps);
  } catch (error) {
    if (isAuthError(error)) throw error; // rate limited → 429 with retry-after
    await recordAudit(
      {
        action: AUDIT_ACTIONS.EMAIL_VERIFICATION_SEND_FAILED,
        actorUserId: authed.id,
        entityType: "User",
        entityId: authed.id,
        metadata: { error: error instanceof Error ? error.name : "unknown" },
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
      deps.db ?? prisma,
    );
    throw new EmailSendFailedError();
  }
  return "requested";
}
