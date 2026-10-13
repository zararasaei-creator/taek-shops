"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * Sends only the four fields the server accepts. The confirmation is the same
 * for a new and an already-registered email (no account enumeration) and never
 * claims an email arrived — only that one is being requested.
 */
export function RegisterForm() {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setReasons([]);
    setPending(true);
    try {
      const sessionResponse = await fetch("/api/auth/session", { cache: "no-store" });
      const { csrfToken } = (await sessionResponse.json()) as { csrfToken: string };

      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ firstName, lastName, email, password }),
      });

      if (response.ok) {
        setDone(true);
        return;
      }
      const body = (await response.json()) as {
        error?: { code?: string; message?: string; details?: unknown };
      };
      if (body.error?.code === "weak_password" && Array.isArray(body.error.details)) {
        setReasons(body.error.details as string[]);
        setError("Please choose a stronger password.");
      } else if (body.error?.code === "validation") {
        setError(
          "Please check your details: both names, a valid email, and a password of at least 10 characters.",
        );
      } else {
        setError(body.error?.message ?? "We could not create your account. Please try again.");
      }
    } catch {
      setError("We could not create your account. Please try again.");
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <div
        role="status"
        data-testid="register-done"
        className="flex max-w-sm flex-col gap-3 text-center text-sm text-zinc-700 dark:text-zinc-300"
      >
        <p>
          Thanks. If that email can be used for a new account, we&apos;re sending it a verification
          link — it may take a few minutes, so check your spam folder too.
        </p>
        <p>
          You can sign in now. If you already have an account, sign in with it or{" "}
          <Link href="/password-reset" className="underline">
            reset your password
          </Link>
          .
        </p>
        <Link href="/login?next=/account" className="font-medium underline">
          Go to sign in
        </Link>
      </div>
    );
  }

  const input =
    "rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900";
  return (
    <form onSubmit={onSubmit} className="flex w-full max-w-sm flex-col gap-4" noValidate>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="firstName" className="text-sm font-medium">
            First name
          </label>
          <input
            id="firstName"
            name="firstName"
            autoComplete="given-name"
            required
            value={firstName}
            onChange={(event) => setFirstName(event.target.value)}
            className={input}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="lastName" className="text-sm font-medium">
            Last name
          </label>
          <input
            id="lastName"
            name="lastName"
            autoComplete="family-name"
            required
            value={lastName}
            onChange={(event) => setLastName(event.target.value)}
            className={input}
          />
        </div>
      </div>
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
          className={input}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="password" className="text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={input}
        />
        <span className="text-xs text-zinc-500">At least 10 characters.</span>
      </div>
      {error ? (
        <div role="alert" className="text-sm text-red-600">
          <p>{error}</p>
          {reasons.length > 0 ? (
            <ul className="mt-1 list-disc pl-5">
              {reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Creating account…" : "Create account"}
      </Button>
      <p className="text-center text-sm text-zinc-500">
        Already have an account?{" "}
        <Link href="/login?next=/account" className="underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
