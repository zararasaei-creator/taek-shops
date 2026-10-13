"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * Requests a password-reset email. `POST /api/auth/password-reset` always
 * returns `{ ok: true }` regardless of whether the email maps to an account
 * (see `requestPasswordReset` in `src/server/auth/verification.ts`) — this
 * form shows the exact same generic confirmation on every submission, and
 * on a network/validation error too, so the UI itself never becomes a
 * second place account existence could leak from.
 */
export function RequestResetForm() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    try {
      const sessionResponse = await fetch("/api/auth/session", { cache: "no-store" });
      const { csrfToken } = (await sessionResponse.json()) as { csrfToken: string };

      await fetch("/api/auth/password-reset", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ email }),
      });
    } finally {
      // Always show the same confirmation, whether the request succeeded,
      // was rate-limited, or failed outright — never distinguish these in
      // the UI.
      setPending(false);
      setSubmitted(true);
    }
  }

  if (submitted) {
    return (
      <p role="status" className="max-w-sm text-center text-sm text-zinc-700 dark:text-zinc-300">
        If an account exists for that email, we&apos;ve sent a link to reset the password. The
        link expires soon and can only be used once.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex w-full max-w-sm flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1">
        <label htmlFor="email" className="text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900"
        />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Sending…" : "Send reset link"}
      </Button>
    </form>
  );
}
