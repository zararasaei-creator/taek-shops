import Link from "next/link";

import { Container } from "@/components/ui/container";
import { requireAuth } from "@/server/auth";
import { hasPermission } from "@/server/auth/authorization";
import { CA_PROVINCES } from "@/lib/validation/checkout";
import { formatCents } from "@/server/domain/money";
import {
  getCheckoutCoverage,
  listShippingZones,
} from "@/server/settings/tax-shipping-service";
import { ActionForm, Checkbox, Field, Select } from "@/components/admin/action-form";
import {
  addShippingZoneRegionAction,
  createShippingMethodAction,
  createShippingZoneAction,
  removeShippingZoneRegionAction,
  updateShippingMethodAction,
  updateShippingZoneAction,
} from "@/app/admin/settings/actions";
import { AccessDenied } from "@/app/admin/settings/access-denied";

export const dynamic = "force-dynamic";

const PROVINCE_OPTIONS = [
  { value: "__choose", label: "Choose…" },
  { value: "", label: "All of Canada" },
  ...CA_PROVINCES.map((p) => ({ value: p, label: p })),
];

const dollars = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2));

export default async function ShippingSettingsPage() {
  const { user } = await requireAuth();
  if (!hasPermission(user, "settings.write")) return <AccessDenied what="shipping configuration" />;

  const [zones, coverage] = await Promise.all([listShippingZones(user), getCheckoutCoverage(user)]);
  const unavailable = coverage.filter((c) => c.shipping.methods.length === 0);

  return (
    <Container className="max-w-5xl py-10">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Shipping methods</h1>
        <Link href="/admin/settings/tax" className="text-sm text-blue-600 underline">
          ← Tax rates
        </Link>
      </div>
      <p className="mt-2 max-w-3xl text-sm text-zinc-600 dark:text-zinc-300">
        Flat-rate shipping. A zone covers provinces/territories; each method in it has a price in{" "}
        <strong>CAD dollars</strong> (type <code>12.50</code>). There is no default price — you must
        enter one, and <code>0.00</code> means <strong>free shipping</strong>, so enter it only on
        purpose. Optionally the method becomes free once the item subtotal reaches a threshold.
        Changes affect <strong>new checkouts only</strong>; existing orders keep the shipping they were
        charged. Nothing is deleted: switch a zone or method off instead.
      </p>

      <section className="mt-6" data-testid="shipping-coverage">
        <h2 className="text-lg font-semibold">What checkout offers right now</h2>
        {unavailable.length > 0 ? (
          <p role="alert" className="mt-1 text-sm text-amber-800 dark:text-amber-300">
            {unavailable.length} of {coverage.length} provinces/territories {unavailable.length === 1 ? "has" : "have"}{" "}
            <strong>no shipping method: customers there
            cannot check out</strong> (the existing rule — nothing is substituted).
          </p>
        ) : null}
        <table className="mt-3 w-full text-left text-sm">
          <thead className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800">
            <tr>
              <th className="py-2 pr-4">Province / territory</th>
              <th className="py-2 pr-4">Options offered (for a $0.00 order)</th>
            </tr>
          </thead>
          <tbody>
            {coverage.map((c) => (
              <tr key={c.province} className="border-b border-zinc-100 dark:border-zinc-900">
                <td className="py-1.5 pr-4 font-medium">{c.province}</td>
                <td className="py-1.5 pr-4" data-testid={`shipping-coverage-${c.province}`}>
                  {c.shipping.methods.length > 0 ? (
                    c.shipping.methods.map((m) => `${m.name} ${formatCents(m.priceCents)}`).join(", ")
                  ) : (
                    <span className="text-amber-800 dark:text-amber-300">
                      NONE — checkout unavailable
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {zones.map((zone) => (
        <section
          key={zone.id}
          className="mt-10 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
          data-testid={`shipping-zone-${zone.name}`}
        >
          <h2 className="text-lg font-semibold">
            {zone.name}{" "}
            <span className="text-sm font-normal text-zinc-500">
              — {zone.active ? "active" : "inactive"}
            </span>
          </h2>
          <ActionForm
            action={updateShippingZoneAction.bind(null, zone.id)}
            submitLabel="Save zone"
            successMessage="Zone saved."
            className="mt-3 flex flex-wrap items-end gap-3"
          >
            <Field label="Zone name" name="name" defaultValue={zone.name} required />
            <Checkbox label="Active" name="active" defaultChecked={zone.active} />
          </ActionForm>

          <h3 className="mt-5 text-sm font-semibold tracking-wide text-zinc-500 uppercase">
            Covers
          </h3>
          <ul className="mt-1 flex flex-wrap gap-2">
            {zone.regions.length === 0 ? (
              <li className="text-sm text-amber-800 dark:text-amber-300">
                No provinces yet — this zone serves nobody.
              </li>
            ) : null}
            {zone.regions.map((r) => (
              <li key={r.id} className="flex items-center gap-1 rounded bg-zinc-100 px-2 py-1 text-xs dark:bg-zinc-800">
                {r.province || "All of Canada"}
                <ActionForm
                  action={removeShippingZoneRegionAction.bind(null, r.id)}
                  submitLabel="Remove"
                  successMessage="Removed."
                  className="inline-flex"
                >
                  <span className="sr-only">Remove {r.province || "all of Canada"} from {zone.name}</span>
                </ActionForm>
              </li>
            ))}
          </ul>
          <ActionForm
            action={addShippingZoneRegionAction.bind(null, zone.id)}
            submitLabel="Add coverage"
            successMessage="Coverage added."
            className="mt-2 flex flex-wrap items-end gap-3"
          >
            <Select label="Province / territory" name="province" options={PROVINCE_OPTIONS} defaultValue="__choose" />
          </ActionForm>

          <h3 className="mt-6 text-sm font-semibold tracking-wide text-zinc-500 uppercase">Methods</h3>
          {zone.methods.length === 0 ? (
            <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
              No methods yet — customers in this zone cannot check out until one is added.
            </p>
          ) : null}
          {zone.methods.map((m) => (
            <ActionForm
              key={m.id}
              action={updateShippingMethodAction.bind(null, m.id)}
              submitLabel="Save method"
              successMessage="Method saved."
              className="mt-3 flex flex-wrap items-end gap-3 border-t border-zinc-100 pt-3 dark:border-zinc-900"
            >
              <div className="min-w-28 text-sm font-medium">{m.name}</div>
              <Field label="Price (CAD $)" name="flatRate" defaultValue={dollars(m.flatRateCents)} required help="0.00 = free" />
              <Field label="Free at/above (CAD $)" name="freeShippingThreshold" defaultValue={dollars(m.freeShippingThresholdCents)} help="Blank = never" />
              <Field label="Min days" name="minDeliveryDays" type="number" defaultValue={m.minDeliveryDays ?? ""} />
              <Field label="Max days" name="maxDeliveryDays" type="number" defaultValue={m.maxDeliveryDays ?? ""} />
              <Field label="Sort order" name="sortOrder" type="number" defaultValue={m.sortOrder} />
              <Field label="Description" name="description" defaultValue={m.description ?? ""} />
              <Checkbox label="Active" name="active" defaultChecked={m.active} />
            </ActionForm>
          ))}

          <h3 className="mt-6 text-sm font-semibold tracking-wide text-zinc-500 uppercase">Add a method</h3>
          <ActionForm
            action={createShippingMethodAction.bind(null, zone.id)}
            submitLabel="Add method"
            successMessage="Method added."
            className="mt-2 flex flex-wrap items-end gap-3"
          >
            <Field label="Method name" name="name" required placeholder="e.g. Standard" />
            <Field label="Price (CAD $)" name="flatRate" required help="No default. 0.00 = free" />
            <Field label="Free at/above (CAD $)" name="freeShippingThreshold" help="Blank = never" />
            <Field label="Min days" name="minDeliveryDays" type="number" />
            <Field label="Max days" name="maxDeliveryDays" type="number" />
            <Field label="Sort order" name="sortOrder" type="number" defaultValue={0} />
            <Field label="Description" name="description" />
            <Checkbox label="Active" name="active" defaultChecked />
          </ActionForm>
        </section>
      ))}

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Add a shipping zone</h2>
        <ActionForm
          action={createShippingZoneAction}
          submitLabel="Create zone"
          successMessage="Zone created."
          className="mt-3 flex flex-wrap items-end gap-3"
        >
          <Field label="Zone name" name="name" required placeholder="e.g. Canada" />
        </ActionForm>
      </section>
    </Container>
  );
}
