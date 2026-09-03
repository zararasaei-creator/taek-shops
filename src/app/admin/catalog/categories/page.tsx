import { UserRole } from "@prisma/client";

import { Container } from "@/components/ui/container";
import { requireRole } from "@/server/auth";
import { hasPermission } from "@/server/auth/authorization";
import { listCategories } from "@/server/catalog/category-service";
import { ActionForm, Field, Select, TextArea } from "@/components/admin/action-form";
import { createCategoryAction } from "@/app/admin/catalog/actions";

export const dynamic = "force-dynamic";

export default async function CategoriesPage() {
  const { user } = await requireRole(UserRole.STAFF);
  const canWrite = hasPermission(user, "catalog.write");
  const categories = await listCategories(user, { includeInactive: true });
  const byId = new Map(categories.map((c) => [c.id, c.name]));

  return (
    <Container className="max-w-3xl py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Categories</h1>

      <table className="mt-4 w-full text-left text-sm">
        <thead className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800">
          <tr>
            <th className="py-2 pr-4">Name</th>
            <th className="py-2 pr-4">Parent</th>
            <th className="py-2 pr-4">Sort</th>
            <th className="py-2 pr-4">Active</th>
          </tr>
        </thead>
        <tbody>
          {categories.map((category) => (
            <tr key={category.id} className="border-b border-zinc-100 dark:border-zinc-900">
              <td className="py-2 pr-4 font-medium">{category.name}</td>
              <td className="py-2 pr-4 text-zinc-500">
                {category.parentId ? (byId.get(category.parentId) ?? "?") : "—"}
              </td>
              <td className="py-2 pr-4">{category.sortOrder}</td>
              <td className="py-2 pr-4">{category.active ? "yes" : "no"}</td>
            </tr>
          ))}
          {categories.length === 0 ? (
            <tr>
              <td colSpan={4} className="py-4 text-center text-zinc-500">
                No categories yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {canWrite ? (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Add a category</h2>
          <ActionForm
            action={createCategoryAction}
            submitLabel="Create category"
            successMessage="Category created."
            className="mt-3 flex flex-col gap-3"
          >
            <Field label="Name" name="name" required />
            <Field label="Slug" name="slug" help="Leave blank to derive from the name." />
            <TextArea label="Description" name="description" />
            <Select
              label="Parent"
              name="parentId"
              defaultValue=""
              options={[
                { value: "", label: "— top level —" },
                ...categories.map((c) => ({ value: c.id, label: c.name })),
              ]}
            />
            <Field label="Sort order" name="sortOrder" type="number" defaultValue={0} />
          </ActionForm>
        </section>
      ) : null}
    </Container>
  );
}
