import type { Metadata } from "next";
import { Container } from "@/components/ui/container";

export const metadata: Metadata = {
  title: "Admin",
  robots: { index: false, follow: false },
};

/**
 * Administration shell. Access control (authenticated admin/staff roles only) is
 * added in the authentication phase; this layout is intentionally unauthenticated
 * scaffolding for now and exposes no data.
 */
export default function AdminLayout({ children }: LayoutProps<"/admin">) {
  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
        <Container as="nav" className="flex h-16 items-center justify-between">
          <span className="text-lg font-semibold tracking-tight">Taek Shops Admin</span>
          <span className="rounded bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900">
            Auth not yet enforced
          </span>
        </Container>
      </header>
      <main id="main-content" className="flex-1">
        {children}
      </main>
    </div>
  );
}
