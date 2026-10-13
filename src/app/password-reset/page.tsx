import type { Metadata } from "next";

import { Container } from "@/components/ui/container";
import { RequestResetForm } from "@/app/password-reset/request-form";

export const metadata: Metadata = {
  title: "Reset your password",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default function PasswordResetPage() {
  return (
    <Container className="flex flex-1 flex-col items-center justify-center gap-8 py-16">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Enter your account email and we&apos;ll send you a link to set a new password.
        </p>
      </div>
      <RequestResetForm />
    </Container>
  );
}
