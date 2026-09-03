import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { UserRole } from "@prisma/client";

import { Container } from "@/components/ui/container";
import { getAuthContext } from "@/server/auth";
import { hasRole } from "@/server/auth/authorization";
import { LogoutButton } from "@/app/admin/logout-button";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Administration shell. Authorization is enforced here on the server (STAFF or
 * above), independently of the optimistic cookie check in `src/proxy.ts`.
 * Individual privileged operations enforce their own finer-grained checks.
 */
export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const context = await getAuthContext();
  if (!context) redirect("/login?next=/admin");
  if (!hasRole(context.user, UserRole.STAFF)) {
    return (
      <Container className="py-16">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-300">
          Your account ({context.user.role.toLowerCase()}) does not have access to the
          administration area.
        </p>
      </Container>
    );
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
        <Container as="nav" className="flex h-16 items-center justify-between">
          <span className="text-lg font-semibold tracking-tight">Taek Shops Admin</span>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-zinc-500">
              {context.user.email} · {context.user.role.toLowerCase()}
            </span>
            <LogoutButton />
          </div>
        </Container>
      </header>
      <main id="main-content" className="flex-1">
        {children}
      </main>
    </div>
  );
}
