import { redirect } from "next/navigation";
import { UserRole } from "@prisma/client";

import { Container } from "@/components/ui/container";
import { requireRole } from "@/server/auth";
import { requirePermission } from "@/server/auth/authorization";
import { listBrands } from "@/server/catalog/brand-service";
import { listCategories } from "@/server/catalog/category-service";
import { ActionForm, Field, Select, TextArea } from "@/components/admin/action-form";
import { createProductAction } from "@/app/admin/catalog/actions";

export const dynamic = "force-dynamic";

export default async function NewProductPage() {
  const { user } = await requireRole(UserRole.STAFF);
  try {
    requirePermission(user, "catalog.write");
  } catch {
    redirect("/admin/catalog/products");
  }

  const [brands, categories] = await Promise.all([
    listBrands(user, { includeInactive: true }),
    listCategories(user, { includeInactive: true }),
  ]);

  return (
    <Container className="max-w-2xl py-10">
      <h1 className="text-2xl font-semibold tracking-tight">New product</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Create the product now; add options and variants on the next screen. Filling SKU + price
        creates a single default variant.
      </p>

      <ActionForm
        action={createProductAction}
        submitLabel="Create product"
        className="mt-6 flex flex-col gap-4"
      >
        <Field label="Name" name="name" required />
        <Field label="Slug" name="slug" help="Leave blank to derive from the name." />
        <TextArea label="Description" name="description" />
        <Select
          label="Status"
          name="status"
          defaultValue="DRAFT"
          options={[
            { value: "DRAFT", label: "Draft" },
            { value: "ACTIVE", label: "Active (needs a variant)" },
          ]}
        />
        <Select
          label="Brand"
          name="brandId"
          defaultValue=""
          options={[
            { value: "", label: "— none —" },
            ...brands.map((b) => ({ value: b.id, label: b.name })),
          ]}
        />
        <Select
          label="Category"
          name="categoryId"
          defaultValue=""
          options={[
            { value: "", label: "— none —" },
            ...categories.map((c) => ({ value: c.id, label: c.name })),
          ]}
        />

        <fieldset className="rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
          <legend className="px-1 text-sm font-medium">Default variant (optional)</legend>
          <div className="flex flex-col gap-3">
            <Field label="SKU" name="sku" placeholder="UNI-STU-WHT-140" />
            <Field label="Price (CAD)" name="price" placeholder="39.99" />
            <Field label="Compare-at price (CAD)" name="compareAtPrice" placeholder="49.99" />
            <Field label="Initial stock" name="initialQuantity" type="number" defaultValue={0} />
          </div>
        </fieldset>
      </ActionForm>
    </Container>
  );
}
