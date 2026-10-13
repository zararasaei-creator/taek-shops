"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";

type Status = "confirm" | "success";

/**
 * Confirms an email-verification link's token. Deliberately requires an
 * explicit button click before anything is submitted — loading this page
 * (a plain GET, including a prefetch from an automated email-link scanner,
 * which many corporate mail gateways perform on every link in every
 * incoming message) must never by itself consume the one-time token. Only
 * the click fires the actual `POST /api/auth/verify-email`
 * (`guardMutation`-protected, same as every other mutation in this app),
 * which is the only thing that calls `confirmEmailVerification` and
 * actually burns the token. This mirrors
 * `src/app/password-reset/confirm/confirm-form.tsx`'s own pattern, where
 * the same property already held for a different reason (a password
 * field requires real input a scanner can't provide) — here it's made the
 * explicit, primary defense since there is no such field to rely on.
 *
 * The token itself is never echoed back into the DOM beyond the one
 * submit call, never logged, and the server's generic `publicMessage` is
 * shown for an invalid, expired, AND already-used token alike — same
 * `InvalidTokenError` the password-reset flow uses, so none of the three
 * are distinguishable here either.
 */
export function ConfirmEmailForm({ token }: { token: string | null }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<Status>("confirm");

  if (!token) {
    return (
      <p role="alert" className="max-w-sm text-center text-sm text-red-600">
        This link is invalid or has expired.
      </p>
    );
  }

  async function onConfirm() {
    setError(null);
    setPending(true);
    try {
      const sessionResponse = await fetch("/api/auth/session", { cache: "no-store" });
      const { csrfToken } = (await sessionResponse.json()) as { csrfToken: string };

      const response = await fetch("/api/auth/verify-email", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ token }),
      });

      if (!response.ok) {
        const body = (await response.json()) as { error?: { message?: string } };
        setError(body.error?.message ?? "This link is invalid or has expired.");
        return;
      }

      setStatus("success");
    } catch {
      setError("This link is invalid or has expired.");
    } finally {
      setPending(false);
    }
  }

  if (status === "success") {
    return (
      <p role="status" className="max-w-sm text-center text-sm text-zinc-700 dark:text-zinc-300">
        Your email address has been verified.{" "}
        <Link href="/login" className="underline">
          Sign in
        </Link>
        .
      </p>
    );
  }

  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-4">
      <p className="text-center text-sm text-zinc-700 dark:text-zinc-300">
        Click below to confirm this is your email address.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      ) : null}
      <Button type="button" onClick={onConfirm} disabled={pending}>
        {pending ? "Verifying…" : "Verify email"}
      </Button>
    </div>
  );
}
