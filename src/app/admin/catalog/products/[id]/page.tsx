import { notFound } from "next/navigation";
import { UserRole } from "@prisma/client";

import { Container } from "@/components/ui/container";
import { requireRole } from "@/server/auth";
import { hasPermission } from "@/server/auth/authorization";
import { NotFoundError } from "@/server/catalog/errors";
import { getProductDetail } from "@/server/catalog/product-service";
import { listProductImages } from "@/server/catalog/image-service";
import { listBrands } from "@/server/catalog/brand-service";
import { listCategories } from "@/server/catalog/category-service";
import { formatCents } from "@/server/domain/money";
import { ActionForm, Field, Select, TextArea } from "@/components/admin/action-form";
import { StatusButtons } from "@/app/admin/catalog/products/[id]/status-buttons";
import {
  addOptionAction,
  addVariantAction,
  updateProductAction,
} from "@/app/admin/catalog/actions";

export const dynamic = "force-dynamic";

export default async function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await requireRole(UserRole.STAFF);
  const canWrite = hasPermission(user, "catalog.write");

  let product;
  try {
    product = await getProductDetail(user, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const [images, brands, categories] = await Promise.all([
    listProductImages(user, product.id),
    listBrands(user, { includeInactive: true }),
    listCategories(user, { includeInactive: true }),
  ]);

  const updateBound = updateProductAction.bind(null, product.id);
  const addOptionBound = addOptionAction.bind(null, product.id);
  const addVariantBound = addVariantAction.bind(null, product.id);

  return (
    <Container className="max-w-4xl py-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{product.name}</h1>
          <p className="text-sm text-zinc-500">
            {product.slug} · <span className="font-medium">{product.status}</span>
          </p>
        </div>
        {canWrite ? <StatusButtons productId={product.id} status={product.status} /> : null}
      </div>

      {!canWrite ? (
        <p className="mt-6 rounded bg-amber-50 p-3 text-sm text-amber-900">
          You have read-only access to the catalogue.
        </p>
      ) : (
        <>
          <section className="mt-8">
            <h2 className="text-lg font-semibold">Details</h2>
            <ActionForm
              action={updateBound}
              submitLabel="Save details"
              className="mt-3 flex flex-col gap-4"
            >
              <Field label="Name" name="name" defaultValue={product.name} required />
              <TextArea
                label="Description"
                name="description"
                defaultValue={product.description ?? ""}
              />
              <Field label="SEO title" name="seoTitle" defaultValue={product.seoTitle ?? ""} />
              <Select
                label="Brand"
                name="brandId"
                defaultValue={product.brandId ?? ""}
                options={[
                  { value: "", label: "— none —" },
                  ...brands.map((b) => ({ value: b.id, label: b.name })),
                ]}
              />
              <Select
                label="Category"
                name="categoryId"
                defaultValue={product.categoryId ?? ""}
                options={[
                  { value: "", label: "— none —" },
                  ...categories.map((c) => ({ value: c.id, label: c.name })),
                ]}
              />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="featured" defaultChecked={product.featured} /> Featured
              </label>
            </ActionForm>
          </section>

          <section className="mt-10">
            <h2 className="text-lg font-semibold">Options</h2>
            {product.options.length === 0 ? (
              <p className="mt-2 text-sm text-zinc-500">
                No options. Add options here before creating variants.
              </p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm">
                {product.options.map((option) => (
                  <li key={option.id}>
                    <span className="font-medium">{option.name}:</span>{" "}
                    {option.values.map((v) => v.value).join(", ")}
                  </li>
                ))}
              </ul>
            )}
            {product.variants.length === 0 ? (
              <ActionForm
                action={addOptionBound}
                submitLabel="Add option"
                successMessage="Option added."
                className="mt-3 flex flex-col gap-3"
              >
                <Field label="Option name" name="name" placeholder="Size" required />
                <Field
                  label="Values"
                  name="values"
                  placeholder="XS, S, M, L, XL"
                  help="Comma- or newline-separated."
                  required
                />
              </ActionForm>
            ) : (
              <p className="mt-3 text-xs text-zinc-500">
                Options are locked once variants exist. Remove all variants to change them.
              </p>
            )}
          </section>

          <section className="mt-10">
            <h2 className="text-lg font-semibold">Variants ({product.variants.length})</h2>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800">
                  <tr>
                    <th className="py-2 pr-4">SKU</th>
                    <th className="py-2 pr-4">Options</th>
                    <th className="py-2 pr-4">Price</th>
                    <th className="py-2 pr-4">On hand</th>
                    <th className="py-2 pr-4">Active</th>
                  </tr>
                </thead>
                <tbody>
                  {product.variants.map((variant) => (
                    <tr key={variant.id} className="border-b border-zinc-100 dark:border-zinc-900">
                      <td className="py-2 pr-4 font-mono text-xs">{variant.sku}</td>
                      <td className="py-2 pr-4">
                        {variant.optionValues
                          .map((ov) => `${ov.option.name}: ${ov.optionValue.value}`)
                          .join(" / ") || "—"}
                      </td>
                      <td className="py-2 pr-4">{formatCents(variant.priceCents)}</td>
                      <td className="py-2 pr-4">{variant.inventoryItem?.quantityOnHand ?? 0}</td>
                      <td className="py-2 pr-4">{variant.active ? "yes" : "no"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-medium">Add a variant</summary>
              <ActionForm
                action={addVariantBound}
                submitLabel="Add variant"
                successMessage="Variant added."
                className="mt-3 flex flex-col gap-3"
              >
                <Field label="SKU" name="sku" required />
                <Field label="Price (CAD)" name="price" placeholder="39.99" required />
                <Field label="Compare-at price (CAD)" name="compareAtPrice" />
                <Field
                  label="Initial stock"
                  name="initialQuantity"
                  type="number"
                  defaultValue={0}
                />
                {product.options.map((option) => (
                  <Select
                    key={option.id}
                    label={option.name}
                    name={`option_${encodeURIComponent(option.name)}`}
                    options={[
                      { value: "", label: "— choose —" },
                      ...option.values.map((v) => ({ value: v.value, label: v.value })),
                    ]}
                  />
                ))}
              </ActionForm>
            </details>
          </section>

          <section className="mt-10">
            <h2 className="text-lg font-semibold">Images ({images.length})</h2>
            <ul className="mt-2 flex flex-wrap gap-3">
              {images.map((image) => (
                <li key={image.id} className="text-xs">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={image.resolvedUrl}
                    alt={image.altText ?? product.name}
                    className="h-24 w-24 rounded border border-zinc-200 object-cover dark:border-zinc-800"
                  />
                  {image.isPrimary ? <div className="mt-1 text-center">primary</div> : null}
                </li>
              ))}
              {images.length === 0 ? (
                <li className="text-sm text-zinc-500">
                  No images. Image upload UI is scheduled for a later phase; the storage abstraction
                  and API are in place.
                </li>
              ) : null}
            </ul>
          </section>
        </>
      )}
    </Container>
  );
}
