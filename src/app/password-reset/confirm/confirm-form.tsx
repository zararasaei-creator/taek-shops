"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";

type Status = "form" | "success";

/**
 * Sets a new password from a reset link's token. The token itself is never
 * echoed back into the DOM beyond the hidden field needed to submit it, never
 * logged, and never shown in any error message — only the server's generic
 * `publicMessage` is rendered (see `InvalidTokenError` in
 * `src/server/auth/errors.ts`), so an invalid, expired, and already-used
 * token are all indistinguishable in this UI, matching the server's own
 * refusal to distinguish them.
 */
export function ConfirmResetForm({ token }: { token: string | null }) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<string[] | null>(null);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<Status>("form");

  if (!token) {
    return (
      <p role="alert" className="max-w-sm text-center text-sm text-red-600">
        This link is invalid or has expired. Request a new one from the{" "}
        <Link href="/password-reset" className="underline">
          password reset page
        </Link>
        .
      </p>
    );
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setReasons(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setPending(true);
    try {
      const sessionResponse = await fetch("/api/auth/session", { cache: "no-store" });
      const { csrfToken } = (await sessionResponse.json()) as { csrfToken: string };

      const response = await fetch("/api/auth/password-reset/confirm", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ token, password }),
      });

      if (!response.ok) {
        const body = (await response.json()) as {
          error?: {
            message?: string;
            // Two distinct shapes can land here for the same underlying
            // problem (a password that's wrong in some way): a plain
            // string array from `WeakPasswordError.reasons` (password
            // passed basic shape validation but failed the richer
            // server-side policy, e.g. a common password), or Zod's own
            // `flatten()` shape (password failed the schema's own
            // min/max-length check before the service even ran). Both are
            // shown the same way — the user doesn't need to know which
            // layer caught it.
            details?: string[] | { fieldErrors?: Record<string, string[] | undefined> };
          };
        };
        const details = body.error?.details;
        const fieldErrorReasons =
          details && !Array.isArray(details) ? details.fieldErrors?.password : undefined;
        setError(body.error?.message ?? "Could not reset the password.");
        setReasons(Array.isArray(details) ? details : (fieldErrorReasons ?? null));
        return;
      }

      setPassword("");
      setConfirmPassword("");
      setStatus("success");
    } catch {
      setError("Could not reset the password. Please try again.");
    } finally {
      setPending(false);
    }
  }

  if (status === "success") {
    return (
      <p role="status" className="max-w-sm text-center text-sm text-zinc-700 dark:text-zinc-300">
        Your password has been reset. You&apos;ve been signed out of any existing sessions —{" "}
        <Link href="/login" className="underline">
          sign in
        </Link>{" "}
        with your new password.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex w-full max-w-sm flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1">
        <label htmlFor="password" className="text-sm font-medium">
          New password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="confirmPassword" className="text-sm font-medium">
          Confirm new password
        </label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        />
      </div>
      {error ? (
        <div role="alert" className="text-sm text-red-600">
          <p>{error}</p>
          {reasons ? (
            <ul className="mt-1 list-inside list-disc">
              {reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Resetting…" : "Reset password"}
      </Button>
    </form>
  );
}
