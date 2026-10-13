import Link from "next/link";

import { Container } from "@/components/ui/container";
import { requireAuth } from "@/server/auth";
import { hasPermission } from "@/server/auth/authorization";
import { CA_PROVINCES } from "@/lib/validation/checkout";
import { fractionToPercent, getCheckoutCoverage, listTaxRegions } from "@/server/settings/tax-shipping-service";
import { ActionForm, Checkbox, Field, Select } from "@/components/admin/action-form";
import {
  createTaxRateAction,
  createTaxRegionAction,
  updateTaxRateAction,
  updateTaxRegionAction,
} from "@/app/admin/settings/actions";
import { AccessDenied } from "@/app/admin/settings/access-denied";

export const dynamic = "force-dynamic";

const PROVINCE_OPTIONS = [
  { value: "__choose", label: "Choose…" },
  { value: "", label: "All of Canada (country-wide fallback)" },
  ...CA_PROVINCES.map((p) => ({ value: p, label: p })),
];

const dateValue = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");

export default async function TaxSettingsPage() {
  const { user } = await requireAuth();
  if (!hasPermission(user, "settings.write")) return <AccessDenied what="tax configuration" />;

  const [regions, coverage] = await Promise.all([listTaxRegions(user), getCheckoutCoverage(user)]);
  const uncovered = coverage.filter((c) => !c.tax.configured);

  return (
    <Container className="max-w-5xl py-10">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Tax rates</h1>
        <Link href="/admin/settings/shipping" className="text-sm text-blue-600 underline">
          Shipping methods →
        </Link>
      </div>
      <p className="mt-2 max-w-3xl text-sm text-zinc-600 dark:text-zinc-300">
        The platform ships no tax rates — every value here is entered by you. Rates are
        <strong> percentages</strong> (type <code>13</code> for 13%), applied to the pre-tax amount of
        each item in <strong>CAD</strong>, rounded to the cent. Which rates are legally required is
        your decision, not the software&apos;s. Changes affect <strong>new checkouts only</strong>;
        existing orders keep the tax they were charged. Nothing is deleted: switch a region or rate
        off instead.
      </p>

      <section className="mt-6" data-testid="tax-coverage">
        <h2 className="text-lg font-semibold">What checkout charges right now</h2>
        {uncovered.length > 0 ? (
          <p role="alert" className="mt-1 text-sm text-amber-800 dark:text-amber-300">
            {uncovered.length} of {coverage.length} provinces/territories {uncovered.length === 1 ? "has" : "have"}{" "}
            <strong>no tax configured: checkout charges $0.00
            tax there</strong> (the existing rule — it is not blocked). Configure a rate if tax applies.
          </p>
        ) : null}
        <table className="mt-3 w-full text-left text-sm">
          <thead className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-800">
            <tr>
              <th className="py-2 pr-4">Province / territory</th>
              <th className="py-2 pr-4">Tax applied to a standard product</th>
            </tr>
          </thead>
          <tbody>
            {coverage.map((c) => (
              <tr key={c.province} className="border-b border-zinc-100 dark:border-zinc-900">
                <td className="py-1.5 pr-4 font-medium">{c.province}</td>
                <td className="py-1.5 pr-4" data-testid={`tax-coverage-${c.province}`}>
                  {c.tax.configured ? (
                    <>
                      {c.tax.rates.map((r) => `${r.name} ${r.percent}%`).join(" + ")}{" "}
                      <span className="text-zinc-500">({c.tax.regionName})</span>
                    </>
                  ) : (
                    <span className="text-amber-800 dark:text-amber-300">
                      NOT CONFIGURED — $0.00 tax charged
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {regions.map((region) => (
        <section
          key={region.id}
          className="mt-10 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
          data-testid={`tax-region-${region.province || "all"}`}
        >
          <h2 className="text-lg font-semibold">
            {region.name}{" "}
            <span className="text-sm font-normal text-zinc-500">
              ({region.province || "country-wide"}, {region.country}) —{" "}
              {region.active ? "active" : "inactive"}
            </span>
          </h2>
          <ActionForm
            action={updateTaxRegionAction.bind(null, region.id)}
            submitLabel="Save region"
            successMessage="Region saved."
            className="mt-3 flex flex-wrap items-end gap-3"
          >
            <Field label="Region name" name="name" defaultValue={region.name} required />
            <Checkbox label="Active" name="active" defaultChecked={region.active} />
          </ActionForm>

          <h3 className="mt-5 text-sm font-semibold tracking-wide text-zinc-500 uppercase">Rates</h3>
          {region.rates.length === 0 ? (
            <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
              No rates yet — a region without an active rate charges no tax.
            </p>
          ) : null}
          {region.rates.map((rate) => (
            <ActionForm
              key={rate.id}
              action={updateTaxRateAction.bind(null, rate.id)}
              submitLabel="Save rate"
              successMessage="Rate saved."
              className="mt-3 flex flex-wrap items-end gap-3 border-t border-zinc-100 pt-3 dark:border-zinc-900"
            >
              <div className="min-w-32 text-sm">
                <div className="font-medium">{rate.name}</div>
                <div className="text-xs text-zinc-500">
                  {rate.taxCategory ? `category “${rate.taxCategory}”` : "all products"}
                </div>
              </div>
              <Field
                label="Rate (%)"
                name="ratePercent"
                defaultValue={fractionToPercent(rate.rate)}
                required
                help="13 = 13%"
              />
              <Field label="Priority" name="priority" type="number" defaultValue={rate.priority} help="Lower applies first" />
              <Field label="From (UTC date)" name="effectiveFrom" type="date" defaultValue={dateValue(rate.effectiveFrom)} />
              <Field label="To (UTC date)" name="effectiveTo" type="date" defaultValue={dateValue(rate.effectiveTo)} />
              <Checkbox label="Compound" name="compound" defaultChecked={rate.compound} help="charged on price + earlier taxes" />
              <Checkbox label="Active" name="active" defaultChecked={rate.active} />
            </ActionForm>
          ))}

          <h3 className="mt-6 text-sm font-semibold tracking-wide text-zinc-500 uppercase">Add a rate</h3>
          <ActionForm
            action={createTaxRateAction.bind(null, region.id)}
            submitLabel="Add rate"
            successMessage="Rate added."
            className="mt-2 flex flex-wrap items-end gap-3"
          >
            <Field label="Tax name" name="name" required placeholder="e.g. GST" />
            <Field label="Rate (%)" name="ratePercent" required help="No default. 13 = 13%" />
            <Field label="Product tax category" name="taxCategory" help="Blank = every product" />
            <Field label="Priority" name="priority" type="number" defaultValue={0} />
            <Field label="From (UTC date)" name="effectiveFrom" type="date" />
            <Field label="To (UTC date)" name="effectiveTo" type="date" />
            <Checkbox label="Compound" name="compound" />
            <Checkbox label="Active" name="active" defaultChecked />
          </ActionForm>
        </section>
      ))}

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Add a tax region</h2>
        <p className="mt-1 text-sm text-zinc-500">
          One region per province/territory, or one country-wide fallback used where no province
          region exists. A region needs at least one active rate to charge tax.
        </p>
        <ActionForm
          action={createTaxRegionAction}
          submitLabel="Create region"
          successMessage="Region created."
          className="mt-3 flex flex-wrap items-end gap-3"
        >
          <Field label="Region name" name="name" required placeholder="e.g. Ontario" />
          <Select label="Applies to" name="province" options={PROVINCE_OPTIONS} defaultValue="__choose" />
        </ActionForm>
      </section>
    </Container>
  );
}
