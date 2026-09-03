import { assertCsrfToken, assertSameOrigin } from "@/lib/http/csrf";
import { readCsrfCookie } from "@/server/auth/cookies";

/**
 * Gate for hand-written mutating route handlers: same-origin + double-submit
 * CSRF token. Call at the top of every non-GET handler under `/api`.
 */
export async function guardMutation(request: Request): Promise<void> {
  assertSameOrigin(request);
  await assertCsrfToken(request, await readCsrfCookie());
}
