import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Container } from "@/components/ui/container";
import { getCurrentUser } from "@/server/auth";
import { ResendVerification } from "@/app/(storefront)/account/resend-verification";

export const metadata: Metadata = {
  title: "Your account",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/account");

  const name = [user.firstName, user.lastName].filter(Boolean).join(" ");

  return (
    <Container className="max-w-xl py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Your account</h1>

      <dl className="mt-6 grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
        {name ? (
          <>
            <dt className="text-zinc-500">Name</dt>
            <dd data-testid="account-name">{name}</dd>
          </>
        ) : null}
        <dt className="text-zinc-500">Email</dt>
        <dd data-testid="account-email">{user.email}</dd>
        <dt className="text-zinc-500">Email status</dt>
        <dd data-testid="account-verification">
          {user.emailVerifiedAt ? "Verified" : "Not verified yet"}
        </dd>
      </dl>

      {user.emailVerifiedAt ? null : (
        <section className="mt-6 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <p className="text-sm text-zinc-700 dark:text-zinc-300">
            Verify your email so we know we can reach you about your orders. You can keep shopping
            and placing orders in the meantime — nothing is blocked until you verify.
          </p>
          <ResendVerification />
        </section>
      )}

      <p className="mt-8">
        <Link href="/account/orders" className="text-sm text-blue-600 underline">
          View my orders →
        </Link>
      </p>
    </Container>
  );
}
