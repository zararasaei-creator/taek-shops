"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { getCurrentUser } from "@/server/auth";
import { isAuthError } from "@/server/auth/errors";
import { isCatalogError } from "@/server/catalog/errors";
import {
  addShippingZoneRegion,
  createShippingMethod,
  createShippingZone,
  createTaxRate,
  createTaxRegion,
  removeShippingZoneRegion,
  updateShippingMethod,
  updateShippingZone,
  updateTaxRate,
  updateTaxRegion,
} from "@/server/settings/tax-shipping-service";

/**
 * Server actions for the admin tax / shipping configuration. Each re-resolves
 * the actor server-side and delegates to `tax-shipping-service.ts`, which
 * enforces `settings.write` and validates every field — the UI is never the
 * security boundary. Server Actions are protected by Next.js's built-in
 * Origin/Host check (the same CSRF defence every other admin form here relies
 * on). Failures come back as `{ ok: false, error }` for the form to render.
 */

export type SettingsActionResult = { ok: true } | { ok: false; error: string };

async function requestMeta() {
  const h = await headers();
  return {
    ipAddress: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: h.get("user-agent"),
  };
}

async function run(
  paths: string[],
  fn: () => Promise<unknown>,
): Promise<SettingsActionResult> {
  try {
    await fn();
    for (const path of paths) revalidatePath(path);
    return { ok: true };
  } catch (error) {
    if (isCatalogError(error) || isAuthError(error)) {
      return { ok: false, error: error.publicMessage };
    }
    throw error;
  }
}

const str = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
};
const checked = (form: FormData, key: string) => form.get(key) === "on";

const TAX = ["/admin/settings/tax"];
const SHIPPING = ["/admin/settings/shipping"];

// ---- Tax ---------------------------------------------------------------------

export async function createTaxRegionAction(_prev: SettingsActionResult | null, form: FormData) {
  const actor = await getCurrentUser();
  const meta = await requestMeta();
  return run(TAX, () =>
    createTaxRegion(actor, { name: str(form, "name"), province: str(form, "province"), active: true }, meta),
  );
}

export async function updateTaxRegionAction(id: string, _prev: SettingsActionResult | null, form: FormData) {
  const actor = await getCurrentUser();
  const meta = await requestMeta();
  return run(TAX, () =>
    updateTaxRegion(actor, id, { name: str(form, "name"), active: checked(form, "active") }, meta),
  );
}

export async function createTaxRateAction(regionId: string, _prev: SettingsActionResult | null, form: FormData) {
  const actor = await getCurrentUser();
  const meta = await requestMeta();
  return run(TAX, () =>
    createTaxRate(
      actor,
      {
        regionId,
        name: str(form, "name"),
        taxCategory: str(form, "taxCategory"),
        ratePercent: str(form, "ratePercent"),
        priority: str(form, "priority") || "0",
        compound: checked(form, "compound"),
        active: checked(form, "active"),
        effectiveFrom: str(form, "effectiveFrom"),
        effectiveTo: str(form, "effectiveTo"),
      },
      meta,
    ),
  );
}

export async function updateTaxRateAction(id: string, _prev: SettingsActionResult | null, form: FormData) {
  const actor = await getCurrentUser();
  const meta = await requestMeta();
  return run(TAX, () =>
    updateTaxRate(
      actor,
      id,
      {
        ratePercent: str(form, "ratePercent"),
        priority: str(form, "priority") || "0",
        compound: checked(form, "compound"),
        active: checked(form, "active"),
        effectiveFrom: str(form, "effectiveFrom"),
        effectiveTo: str(form, "effectiveTo"),
      },
      meta,
    ),
  );
}

// ---- Shipping ----------------------------------------------------------------

export async function createShippingZoneAction(_prev: SettingsActionResult | null, form: FormData) {
  const actor = await getCurrentUser();
  const meta = await requestMeta();
  return run(SHIPPING, () => createShippingZone(actor, { name: str(form, "name"), active: true }, meta));
}

export async function updateShippingZoneAction(id: string, _prev: SettingsActionResult | null, form: FormData) {
  const actor = await getCurrentUser();
  const meta = await requestMeta();
  return run(SHIPPING, () =>
    updateShippingZone(actor, id, { name: str(form, "name"), active: checked(form, "active") }, meta),
  );
}

export async function addShippingZoneRegionAction(
  zoneId: string,
  _prev: SettingsActionResult | null,
  form: FormData,
) {
  const actor = await getCurrentUser();
  const meta = await requestMeta();
  return run(SHIPPING, () => addShippingZoneRegion(actor, { zoneId, province: str(form, "province") }, meta));
}

export async function removeShippingZoneRegionAction(
  regionId: string,
  _prev: SettingsActionResult | null,
  _form: FormData,
) {
  const actor = await getCurrentUser();
  const meta = await requestMeta();
  return run(SHIPPING, () => removeShippingZoneRegion(actor, regionId, meta));
}

function methodFields(form: FormData) {
  return {
    description: str(form, "description"),
    flatRateCents: str(form, "flatRate"),
    freeShippingThresholdCents: str(form, "freeShippingThreshold"),
    minDeliveryDays: str(form, "minDeliveryDays"),
    maxDeliveryDays: str(form, "maxDeliveryDays"),
    sortOrder: str(form, "sortOrder") || "0",
    active: checked(form, "active"),
  };
}

export async function createShippingMethodAction(
  zoneId: string,
  _prev: SettingsActionResult | null,
  form: FormData,
) {
  const actor = await getCurrentUser();
  const meta = await requestMeta();
  return run(SHIPPING, () =>
    createShippingMethod(actor, { zoneId, name: str(form, "name"), ...methodFields(form) }, meta),
  );
}

export async function updateShippingMethodAction(
  id: string,
  _prev: SettingsActionResult | null,
  form: FormData,
) {
  const actor = await getCurrentUser();
  const meta = await requestMeta();
  return run(SHIPPING, () => updateShippingMethod(actor, id, methodFields(form), meta));
}
