import Link from "next/link";

import { Container } from "@/components/ui/container";
import { requireRole } from "@/server/auth";
import { hasPermission } from "@/server/auth/authorization";
import { prisma } from "@/server/db/client";
import { UserRole } from "@prisma/client";

export const dynamic = "force-dynamic";

export default async function CatalogHomePage() {
  const { user } = await requireRole(UserRole.STAFF);
  const canWrite = hasPermission(user, "catalog.write");

  const [products, activeProducts, variants, brands, categories, lowStock] = await Promise.all([
    prisma.product.count(),
    prisma.product.count({ where: { status: "ACTIVE" } }),
    prisma.productVariant.count(),
    prisma.brand.count(),
    prisma.category.count(),
    prisma.inventoryItem.count({ where: { reorderLevel: { not: null } } }),
  ]);

  const cards = [
    {
      href: "/admin/catalog/products",
      title: "Products",
      value: `${products} (${activeProducts} active)`,
    },
    { href: "/admin/catalog/products", title: "Variants", value: variants },
    { href: "/admin/catalog/brands", title: "Brands", value: brands },
    { href: "/admin/catalog/categories", title: "Categories", value: categories },
    { href: "/admin/catalog/inventory", title: "Inventory (tracked)", value: lowStock },
    {
      href: "/admin/catalog/import",
      title: "Import products (CSV)",
      value: canWrite ? "Upload" : "—",
    },
  ];

  return (
    <Container className="py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Catalogue</h1>
      <p className="mt-1 text-sm text-zinc-500">
        {canWrite ? "You can manage products, inventory and imports." : "Read-only access."}
      </p>
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => (
          <Link
            key={card.title}
            href={card.href}
            className="rounded-lg border border-zinc-200 p-4 transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
          >
            <div className="text-sm text-zinc-500">{card.title}</div>
            <div className="mt-1 text-xl font-semibold">{card.value}</div>
          </Link>
        ))}
      </div>
    </Container>
  );
}
