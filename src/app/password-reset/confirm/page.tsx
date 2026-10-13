import type { Metadata } from "next";

import { Container } from "@/components/ui/container";
import { ConfirmResetForm } from "@/app/password-reset/confirm/confirm-form";

export const metadata: Metadata = {
  title: "Set a new password",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function PasswordResetConfirmPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <Container className="flex flex-1 flex-col items-center justify-center gap-8 py-16">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Set a new password</h1>
      </div>
      <ConfirmResetForm token={token ?? null} />
    </Container>
  );
}
