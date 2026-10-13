import type { Metadata } from "next";

import { Container } from "@/components/ui/container";
import { ConfirmEmailForm } from "@/app/verify-email/confirm-form";

export const metadata: Metadata = {
  title: "Verify your email",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <Container className="flex flex-1 flex-col items-center justify-center gap-8 py-16">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Verify your email</h1>
      </div>
      <ConfirmEmailForm token={token ?? null} />
    </Container>
  );
}
