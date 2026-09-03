import { UserRole } from "@prisma/client";

import { Container } from "@/components/ui/container";
import { requireRole } from "@/server/auth";
import { hasPermission } from "@/server/auth/authorization";
import { listBrands } from "@/server/catalog/brand-service";
import { ActionForm, Field, TextArea } from "@/components/admin/action-form";
import { createBrandAction } from "@/app/admin/catalog/actions";

export const dynamic = "force-dynamic";

export default async function BrandsPage() {
  const { user } = await requireRole(UserRole.STAFF);
  const canWrite = hasPermission(user, "catalog.write");
  const brands = await listBrands(user, { includeInactive: true });

  return (
    <Container className="max-w-3xl py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Brands</h1>

      <table className="mt-4 w-full text-left text-sm">
        <thead className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800">
          <tr>
            <th className="py-2 pr-4">Name</th>
            <th className="py-2 pr-4">Slug</th>
            <th className="py-2 pr-4">Active</th>
          </tr>
        </thead>
        <tbody>
          {brands.map((brand) => (
            <tr key={brand.id} className="border-b border-zinc-100 dark:border-zinc-900">
              <td className="py-2 pr-4 font-medium">{brand.name}</td>
              <td className="py-2 pr-4 text-zinc-500">{brand.slug}</td>
              <td className="py-2 pr-4">{brand.active ? "yes" : "no"}</td>
            </tr>
          ))}
          {brands.length === 0 ? (
            <tr>
              <td colSpan={3} className="py-4 text-center text-zinc-500">
                No brands yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {canWrite ? (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Add a brand</h2>
          <ActionForm
            action={createBrandAction}
            submitLabel="Create brand"
            successMessage="Brand created."
            className="mt-3 flex flex-col gap-3"
          >
            <Field label="Name" name="name" required />
            <Field label="Slug" name="slug" help="Leave blank to derive from the name." />
            <TextArea label="Description" name="description" />
          </ActionForm>
        </section>
      ) : null}
    </Container>
  );
}
