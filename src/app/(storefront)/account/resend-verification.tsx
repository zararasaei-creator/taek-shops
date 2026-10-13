"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * Authenticated "resend verification email". Takes no input — the server uses
 * the signed-in user's address. Reports what actually happened (requested /
 * rate limited / could not send) and never claims the message reached an inbox.
 */
export function ResendVerification() {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function onClick() {
    setPending(true);
    setMessage(null);
    try {
      const sessionResponse = await fetch("/api/auth/session", { cache: "no-store" });
      const { csrfToken } = (await sessionResponse.json()) as { csrfToken: string };

      const response = await fetch("/api/auth/verify-email/resend", {
        method: "POST",
        headers: { "x-csrf-token": csrfToken },
      });
      const body = (await response.json()) as {
        result?: string;
        error?: { code?: string; message?: string };
      };

      if (response.ok) {
        setMessage({
          kind: "ok",
          text:
            body.result === "already_verified"
              ? "Your email is already verified. Refresh the page."
              : "A new verification link was requested. It may take a few minutes to arrive — check your spam folder, and try again below if it does not.",
        });
      } else if (body.error?.code === "rate_limited") {
        setMessage({
          kind: "error",
          text: "Too many requests. Please wait a while before asking for another link.",
        });
      } else {
        setMessage({
          kind: "error",
          text: body.error?.message ?? "We could not send the email just now. Please try again shortly.",
        });
      }
    } catch {
      setMessage({ kind: "error", text: "We could not send the email just now. Please try again shortly." });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-2">
      <Button type="button" variant="secondary" disabled={pending} onClick={onClick}>
        {pending ? "Requesting…" : "Resend verification email"}
      </Button>
      {message ? (
        <p
          role={message.kind === "error" ? "alert" : "status"}
          data-testid="resend-message"
          className={message.kind === "error" ? "text-sm text-red-600" : "text-sm text-zinc-700 dark:text-zinc-300"}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
