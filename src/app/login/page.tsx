import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Container } from "@/components/ui/container";
import { getAuthContext } from "@/server/auth";
import { LoginForm } from "@/app/login/login-form";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/admin";

  const context = await getAuthContext();
  if (context) redirect(safeNext);

  return (
    <Container className="flex flex-1 flex-col items-center justify-center gap-8 py-16">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-1 text-sm text-zinc-500">Taek Shops staff &amp; administration</p>
      </div>
      <LoginForm next={safeNext} />
    </Container>
  );
}
