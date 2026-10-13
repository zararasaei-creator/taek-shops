/**
 * Rate-limiting foundation for sensitive auth operations.
 *
 * `RateLimiter` is the seam. Phase 3 ships an in-process fixed-window limiter,
 * which is correct for a single instance and useful in development/tests. A
 * multi-instance production deployment MUST swap in a shared-store implementation
 * (Redis / Upstash / a database counter) — see `docs/security.md`. Nothing else
 * in the codebase should reach past this interface.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
  reset(key: string): Promise<void>;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  async consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const existing = this.buckets.get(key);

    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
    }

    if (existing.count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      };
    }

    existing.count += 1;
    return { allowed: true, remaining: limit - existing.count, retryAfterSeconds: 0 };
  }

  async reset(key: string): Promise<void> {
    this.buckets.delete(key);
  }

  /** Test/maintenance helper. */
  clear(): void {
    this.buckets.clear();
  }
}

/** Policy: limit + window per sensitive operation. */
export const RATE_LIMITS = {
  login: { limit: 10, windowSeconds: 15 * 60 },
  passwordResetRequest: { limit: 5, windowSeconds: 60 * 60 },
  verificationRequest: { limit: 5, windowSeconds: 60 * 60 },
  // Customer self-registration: applied per email AND per client IP.
  registration: { limit: 10, windowSeconds: 60 * 60 },
} as const;

export type RateLimitedOperation = keyof typeof RATE_LIMITS;

/** Process-wide default limiter. Replace the binding for production. */
export const rateLimiter: RateLimiter = new InMemoryRateLimiter();

export async function enforceRateLimit(
  operation: RateLimitedOperation,
  identifier: string,
  limiter: RateLimiter = rateLimiter,
): Promise<RateLimitResult> {
  const policy = RATE_LIMITS[operation];
  return limiter.consume(`${operation}:${identifier}`, policy.limit, policy.windowSeconds);
}
