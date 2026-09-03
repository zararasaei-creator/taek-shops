import Link from "next/link";

import { Container } from "@/components/ui/container";
import { requireRole } from "@/server/auth";
import { permissionsForRole } from "@/server/auth/authorization";
import { UserRole } from "@prisma/client";

export const dynamic = "force-dynamic";

export default async function AdminDashboardPage() {
  const { user } = await requireRole(UserRole.STAFF);
  const permissions = [...permissionsForRole(user.role)].sort();

  return (
    <Container className="py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <p className="mt-4 max-w-2xl text-zinc-600 dark:text-zinc-300">
        Signed in as <strong>{user.email}</strong> with role <strong>{user.role}</strong>.
      </p>
      <div className="mt-6">
        <h2 className="text-sm font-semibold tracking-wide text-zinc-500 uppercase">
          Effective permissions
        </h2>
        {permissions.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">None.</p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-2">
            {permissions.map((permission) => (
              <li
                key={permission}
                className="rounded bg-zinc-100 px-2 py-1 font-mono text-xs dark:bg-zinc-800"
              >
                {permission}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link
          href="/admin/catalog"
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Catalogue management
        </Link>
        <Link
          href="/admin/catalog/import"
          className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Import products (CSV)
        </Link>
      </div>
      <p className="mt-6 max-w-2xl text-sm text-zinc-500">
        Orders, checkout, and payments are scheduled for later phases.
      </p>
    </Container>
  );
}
