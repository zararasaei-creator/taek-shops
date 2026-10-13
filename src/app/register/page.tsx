import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Container } from "@/components/ui/container";
import { getAuthContext } from "@/server/auth";
import { RegisterForm } from "@/app/register/register-form";

export const metadata: Metadata = {
  title: "Create an account",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function RegisterPage() {
  if (await getAuthContext()) redirect("/account");

  return (
    <Container className="flex flex-1 flex-col items-center justify-center gap-8 py-16">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Create an account</h1>
        <p className="mt-1 text-sm text-zinc-500">
          An account lets you see your orders. You can still check out as a guest at any time.
        </p>
      </div>
      <RegisterForm />
    </Container>
  );
}
