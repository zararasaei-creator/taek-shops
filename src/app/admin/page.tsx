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
      <p className="mt-8 max-w-2xl text-sm text-zinc-500">
        Catalogue, inventory, orders, and import management are scheduled for later phases.
      </p>
    </Container>
  );
}
