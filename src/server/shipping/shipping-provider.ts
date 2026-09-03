import type { PrismaClient } from "@prisma/client";

import { prisma } from "@/server/db/client";

/**
 * Shipping boundary (Phase 6).
 *
 * No shipping prices in code. Operator data lives in `ShippingZone`,
 * `ShippingZoneRegion` (country + optional province), and `ShippingMethod`
 * (`flatRateCents`, optional `freeShippingThresholdCents`, delivery-day range).
 * The seed adds an example "Canada / Standard" method (Phase 11 adds the admin
 * UI). The selected option's price is frozen onto the order.
 */

export interface Parcel {
  /** Total parcel weight from `ProductVariant.weightGrams`. */
  weightGrams: number;
  /** Merchandise subtotal, integer cents — drives free-shipping thresholds. */
  subtotalCents: number;
}

export interface ShipDestination {
  country: string;
  province: string;
}

export interface ShippingOption {
  methodId: string;
  name: string;
  description: string | null;
  priceCents: number;
  /** True when a free-shipping threshold applied and made this option free. */
  free: boolean;
  minDeliveryDays: number | null;
  maxDeliveryDays: number | null;
}

export interface ShippingRateProvider {
  /** `shipFrom` is part of the interface contract (carrier adapters need it); the
   *  flat-rate implementation ignores it. */
  rates(
    parcel: Parcel,
    shipFrom: ShipDestination,
    shipTo: ShipDestination,
  ): Promise<ShippingOption[]>;
}

type Db = Pick<PrismaClient, "shippingMethod">;

/**
 * Flat-rate provider: every active `ShippingMethod` whose zone covers the
 * destination (exact province match or a country-wide `province = ""` row).
 * `freeShippingThresholdCents`, when set and met by the subtotal, zeroes the
 * price.
 */
export class FlatRateShippingProvider implements ShippingRateProvider {
  constructor(private readonly db: Db = prisma) {}

  async rates(
    parcel: Parcel,
    _shipFrom: ShipDestination,
    shipTo: ShipDestination,
  ): Promise<ShippingOption[]> {
    const methods = await this.db.shippingMethod.findMany({
      where: {
        active: true,
        zone: {
          active: true,
          regions: {
            some: { country: shipTo.country, province: { in: [shipTo.province, ""] } },
          },
        },
      },
      orderBy: [{ sortOrder: "asc" }, { flatRateCents: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        description: true,
        flatRateCents: true,
        freeShippingThresholdCents: true,
        minDeliveryDays: true,
        maxDeliveryDays: true,
      },
    });

    return methods.map((m) => {
      const free =
        m.freeShippingThresholdCents != null &&
        parcel.subtotalCents >= m.freeShippingThresholdCents;
      return {
        methodId: m.id,
        name: m.name,
        description: m.description,
        priceCents: free ? 0 : m.flatRateCents,
        free,
        minDeliveryDays: m.minDeliveryDays,
        maxDeliveryDays: m.maxDeliveryDays,
      };
    });
  }
}

/** The active shipping provider. A carrier-API adapter can be swapped in here. */
export function getShippingProvider(db: Db = prisma): ShippingRateProvider {
  return new FlatRateShippingProvider(db);
}
