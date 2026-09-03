import { UserRole } from "@prisma/client";

import { Container } from "@/components/ui/container";
import { requireRole } from "@/server/auth";
import { hasPermission } from "@/server/auth/authorization";
import { prisma } from "@/server/db/client";
import { listLowStock } from "@/server/inventory/inventory-service";
import { ActionForm, Field, Select } from "@/components/admin/action-form";
import { adjustInventoryAction } from "@/app/admin/catalog/actions";

export const dynamic = "force-dynamic";

export default async function InventoryPage() {
  const { user } = await requireRole(UserRole.STAFF);
  const canWrite = hasPermission(user, "inventory.write");

  const [lowStock, recent] = await Promise.all([
    listLowStock(user),
    prisma.stockMovement.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        type: true,
        quantityDelta: true,
        reason: true,
        createdAt: true,
        variant: { select: { sku: true } },
      },
    }),
  ]);

  return (
    <Container className="max-w-3xl py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Inventory</h1>

      <section className="mt-6">
        <h2 className="text-lg font-semibold">Low stock ({lowStock.length})</h2>
        {lowStock.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">Nothing at or below its reorder level.</p>
        ) : (
          <table className="mt-2 w-full text-left text-sm">
            <thead className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800">
              <tr>
                <th className="py-2 pr-4">SKU</th>
                <th className="py-2 pr-4">Available</th>
                <th className="py-2 pr-4">Reorder at</th>
              </tr>
            </thead>
            <tbody>
              {lowStock.map((item) => (
                <tr
                  key={item.inventoryItemId}
                  className="border-b border-zinc-100 dark:border-zinc-900"
                >
                  <td className="py-2 pr-4 font-mono text-xs">{item.sku}</td>
                  <td className="py-2 pr-4">{item.available}</td>
                  <td className="py-2 pr-4">{item.reorderLevel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {canWrite ? (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Adjust stock</h2>
          <p className="mt-1 text-xs text-zinc-500">
            Every adjustment writes a stock movement and an audit record. On-hand can never go
            negative or below reserved.
          </p>
          <ActionForm
            action={adjustInventoryAction}
            submitLabel="Apply adjustment"
            successMessage="Stock adjusted."
            className="mt-3 flex flex-col gap-3"
          >
            <Field label="SKU" name="sku" required />
            <Select
              label="Mode"
              name="mode"
              defaultValue="delta"
              options={[
                { value: "delta", label: "Change by (e.g. -3 or 10)" },
                { value: "set", label: "Set on-hand to" },
              ]}
            />
            <Field label="Amount" name="amount" type="number" required />
            <Select
              label="Movement type"
              name="type"
              defaultValue="ADJUSTMENT"
              options={[
                { value: "ADJUSTMENT", label: "Adjustment" },
                { value: "PURCHASE", label: "Purchase / received" },
                { value: "RETURN", label: "Customer return" },
                { value: "INITIAL", label: "Opening balance" },
              ]}
            />
            <Field label="Reason" name="reason" required placeholder="Cycle count correction" />
            <Field label="Reference" name="reference" placeholder="PO-1234 (optional)" />
          </ActionForm>
        </section>
      ) : null}

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Recent movements</h2>
        <table className="mt-2 w-full text-left text-sm">
          <tbody>
            {recent.map((movement) => (
              <tr key={movement.id} className="border-b border-zinc-100 dark:border-zinc-900">
                <td className="py-1 pr-3 text-zinc-500">
                  {movement.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                </td>
                <td className="py-1 pr-3 font-mono text-xs">{movement.variant.sku}</td>
                <td className="py-1 pr-3">{movement.type}</td>
                <td className="py-1 pr-3">
                  {movement.quantityDelta > 0
                    ? `+${movement.quantityDelta}`
                    : movement.quantityDelta}
                </td>
                <td className="py-1 pr-3 text-zinc-500">{movement.reason}</td>
              </tr>
            ))}
            {recent.length === 0 ? (
              <tr>
                <td className="py-3 text-zinc-500">No movements recorded.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </Container>
  );
}
